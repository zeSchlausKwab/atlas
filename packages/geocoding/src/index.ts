import { AtlasReader } from "../../format/src/reader";
import {
  type Location,
  type Street,
  type Position,
  type LocationBlock,
  type StreetBlock,
  normalize,
  validPosition,
  nearestOnLine,
  REVERSE_LIMIT_METERS,
} from "./model";
export * from "./model";
export interface SearchResult {
  matches: Location[];
  total: number;
  snapshot: string;
  cached: boolean;
  scope: string;
}
export interface ReverseResult {
  match: (Street & { nearest: Position; distanceMeters: number }) | null;
  requested: Position;
  limitMeters: number;
  snapshot: string;
  cached: boolean;
  scope: string;
}
const SCOPE = "Retained OSM data in this source extract";
function aliasesValid(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((s) => typeof s === "string" && s.length <= 1000)
  );
}
function baseValid(r: unknown): r is Location | Street {
  if (!r || typeof r !== "object") return false;
  const v = r as Location;
  return (
    typeof v.id === "string" &&
    /^(node|way|relation)\/\d+$/.test(v.id) &&
    typeof v.category === "string" &&
    aliasesValid(v.aliases)
  );
}
function locations(bytes: Uint8Array) {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as LocationBlock;
  if (
    data?.schema !== "locations-v1" ||
    !Array.isArray(data.records) ||
    data.records.length > 1000000 ||
    !data.records.every(
      (r) =>
        baseValid(r) &&
        typeof r.name === "string" &&
        r.name.length > 0 &&
        r.name.length <= 1000 &&
        ["place", "street", "poi", "peak"].includes(r.kind) &&
        validPosition(r.coordinates) &&
        (r.context === undefined || typeof r.context === "string"),
    )
  )
    throw new Error("Invalid location search block");
  if (new Set(data.records.map((r) => r.id)).size !== data.records.length)
    throw new Error("Duplicate search identity");
  return data.records.map((record) => ({
    record,
    names: [record.name, ...record.aliases].map(normalize),
    context: normalize(record.context ?? ""),
  }));
}
function streets(bytes: Uint8Array) {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as StreetBlock;
  let points = 0;
  if (
    data?.schema !== "streets-v1" ||
    !Array.isArray(data.streets) ||
    data.streets.length > 1000000 ||
    !data.streets.every(
      (r) =>
        baseValid(r) &&
        (r.name === null || typeof r.name === "string") &&
        Array.isArray(r.coordinates) &&
        r.coordinates.length >= 2 &&
        (points += r.coordinates.length) <= 10000000 &&
        r.coordinates.every(validPosition),
    )
  )
    throw new Error("Invalid reverse street block");
  return data.streets.map((street) => {
    const bounds: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ];
    for (const [x, y] of street.coordinates) {
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x);
      bounds[3] = Math.max(bounds[3], y);
    }
    return { street, bounds };
  });
}
export class AtlasGeocoder {
  private names?: ReturnType<typeof locations>;
  private roads?: ReturnType<typeof streets>;
  private pendingNames?: Promise<void>;
  private pendingRoads?: Promise<void>;
  constructor(readonly reader: AtlasReader) {}
  private async load(
    key: "search/locations" | "search/streets",
    capability: string,
  ) {
    if (!this.reader.index.manifest.capabilities.includes(capability))
      throw new Error(
        "This package has no geocoding data. Rebuild it with the current generator.",
      );
    if (this.reader.offline && !this.reader.cache.has(key))
      throw new Error(
        `${key === "search/locations" ? "Location index" : "Street geometry"} is not cached. Turn off Cache only and try again.`,
      );
    return this.reader.block(key);
  }
  async search(query: string, limit = 8): Promise<SearchResult> {
    const q = normalize(query),
      snapshot = this.reader.index.manifest.snapshot,
      cached = this.reader.cache.has("search/locations");
    if (!Number.isInteger(limit) || limit < 1 || limit > 30)
      throw new Error("Search limit must be 1–30");
    if (q.length < 2 || q.length > 120)
      throw new Error("Enter between 2 and 120 searchable characters.");
    if (!this.names) {
      this.pendingNames ??= this.load("search/locations", "location-search")
        .then((bytes) => {
          this.names = locations(bytes);
        })
        .finally(() => {
          this.pendingNames = undefined;
        });
      await this.pendingNames;
    }
    const tokens = q.split(" ");
    const ranked = this.names!.flatMap(({ record, names, context }) => {
      let score = Infinity;
      for (const name of names) {
        const words = name.split(" ");
        if (name === q) score = Math.min(score, 0);
        else if (name.startsWith(q)) score = Math.min(score, 1);
        else if (tokens.every((t) => words.some((w) => w.startsWith(t))))
          score = Math.min(score, 2);
        else if (tokens.every((t) => name.includes(t)))
          score = Math.min(score, 3);
        else if (
          tokens.some((t) => name.includes(t)) &&
          tokens.every((t) => `${name} ${context}`.includes(t))
        )
          score = Math.min(score, 4);
      }
      return Number.isFinite(score) ? [{ record, score }] : [];
    }).sort(
      (a, b) =>
        a.score - b.score ||
        (a.record.kind === "place" ? 0 : 1) -
          (b.record.kind === "place" ? 0 : 1) ||
        a.record.name.localeCompare(b.record.name, "de") ||
        a.record.id.localeCompare(b.record.id),
    );
    return {
      matches: ranked.slice(0, limit).map((r) => r.record),
      total: ranked.length,
      snapshot,
      cached,
      scope: SCOPE,
    };
  }
  async reverse(point: Position): Promise<ReverseResult> {
    if (!validPosition(point))
      throw new Error("Invalid longitude/latitude coordinate");
    const cached = this.reader.cache.has("search/streets");
    if (!this.roads) {
      this.pendingRoads ??= this.load("search/streets", "reverse-street")
        .then((bytes) => {
          this.roads = streets(bytes);
        })
        .finally(() => {
          this.pendingRoads = undefined;
        });
      await this.pendingRoads;
    }
    // Bounding-box prefilter for a 1 km spherical cap, then exact local segment tests.
    const angular = REVERSE_LIMIT_METERS / 6371000,
      dy = (angular * 180) / Math.PI;
    const dx =
      (Math.asin(Math.sin(angular) / Math.cos((point[1] * Math.PI) / 180)) *
        180) /
      Math.PI;
    let match: ReverseResult["match"] = null;
    for (const {
      street,
      bounds: [w, s, e, n],
    } of this.roads!) {
      if (
        e < point[0] - dx ||
        w > point[0] + dx ||
        n < point[1] - dy ||
        s > point[1] + dy
      )
        continue;
      const near = nearestOnLine(point, street.coordinates);
      if (
        near.distanceMeters <= REVERSE_LIMIT_METERS &&
        (!match || near.distanceMeters < match.distanceMeters)
      )
        match = {
          ...street,
          nearest: near.coordinates,
          distanceMeters: near.distanceMeters,
        };
    }
    return {
      match,
      requested: point,
      limitMeters: REVERSE_LIMIT_METERS,
      snapshot: this.reader.index.manifest.snapshot,
      cached,
      scope: SCOPE,
    };
  }
}
