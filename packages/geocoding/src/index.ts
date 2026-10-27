import { readSearchCell } from "./cell-pages";
import { project } from "../../format/src/index";
import {
  ordinalKey,
  termBucket,
  termKey,
  queryGrams,
  RECORDS_PER_PAGE,
  POSTINGS_PER_PAGE,
  STREET_ZOOM,
  MAX_SEARCH_PAGE,
  MAX_CANDIDATES,
  type SearchCatalog,
  type Term,
} from "./paging";
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
export function decodeLocations(bytes: Uint8Array) {
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
        ["place", "street", "poi", "peak", "address"].includes(r.kind) &&
        (r.tags === undefined ||
          (r.tags !== null &&
            typeof r.tags === "object" &&
            !Array.isArray(r.tags) &&
            Object.entries(r.tags).every(
              ([k, v]) =>
                k.length <= 256 && typeof v === "string" && v.length <= 10000,
            ))) &&
        (r.address === undefined ||
          (r.address !== null &&
            typeof r.address === "object" &&
            r.address.source === "osm-explicit" &&
            typeof r.address.houseNumber === "string" &&
            r.address.houseNumber.length > 0 &&
            r.address.houseNumber.length <= 1000 &&
            ["street", "place", "city", "postcode", "country"].every((key) => {
              const value = r.address![key as keyof typeof r.address];
              return (
                value === undefined ||
                (typeof value === "string" && value.length <= 1000)
              );
            }))) &&
        validPosition(r.coordinates) &&
        (r.context === undefined || typeof r.context === "string"),
    )
  )
    throw new Error("Invalid location search block");
  if (new Set(data.records.map((r) => r.id)).size !== data.records.length)
    throw new Error("Duplicate search identity");
  return data.records;
}
/** Name normalization is only needed for text search, not spatial workspace scans. */
export function locations(bytes: Uint8Array) {
  return decodeLocations(bytes).map((record) => ({
    record,
    names: [record.name, ...record.aliases].map(normalize),
    context: normalize(record.context ?? ""),
  }));
}
export function streets(bytes: Uint8Array) {
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
export function rankLocations(names: ReturnType<typeof locations>, q: string) {
  const tokens = q.split(" ");
  return names
    .flatMap(({ record, names, context }) => {
      // Address numbers are exact tokens: "12" must not match "123".
      const words = `${names.join(" ")} ${context}`.split(" ");
      if (
        record.address &&
        tokens.some((t) => /^\d+[\p{L}]?$/u.test(t) && !words.includes(t))
      )
        return [];
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
    })
    .sort(
      (a, b) =>
        a.score - b.score ||
        (a.record.kind === "place" ? 0 : 1) -
          (b.record.kind === "place" ? 0 : 1) ||
        a.record.name.localeCompare(b.record.name, "de") ||
        a.record.id.localeCompare(b.record.id),
    );
}
export interface SearchFilter {
  tag?: { key: string; value: string };
}
const filterLocations = (
  ranked: ReturnType<typeof rankLocations>,
  filter?: SearchFilter,
) =>
  filter?.tag
    ? ranked.filter(
        ({ record }) => record.tags?.[filter.tag!.key] === filter.tag!.value,
      )
    : ranked;
export class AtlasGeocoder {
  private catalog?: SearchCatalog;
  private pagedStreets = false;
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
  async search(
    query: string,
    limit = 8,
    filter?: SearchFilter,
  ): Promise<SearchResult> {
    const q = normalize(query),
      snapshot = this.reader.index.manifest.snapshot,
      cached = !!this.names || this.reader.cache.has("search/locations");
    if (!Number.isInteger(limit) || limit < 1 || limit > 30)
      throw new Error("Search limit must be 1–30");
    if (q.length < 2 || q.length > 120)
      throw new Error("Enter between 2 and 120 searchable characters.");
    if (!this.names && !this.catalog) {
      this.pendingNames ??= this.load("search/locations", "location-search")
        .then((bytes) => {
          const root = JSON.parse(new TextDecoder().decode(bytes));
          if (root.schema === "locations-paged-v1") {
            if (
              !Number.isSafeInteger(root.records) ||
              root.records < 0 ||
              root.records > 2 ** 32 ||
              root.pages !== Math.ceil(root.records / RECORDS_PER_PAGE)
            )
              throw new Error("Invalid paged search catalog");
            this.catalog = root;
          } else this.names = locations(bytes);
        })
        .finally(() => {
          this.pendingNames = undefined;
        });
      await this.pendingNames;
    }
    if (this.catalog) return this.searchPaged(q, limit, filter);
    const ranked = filterLocations(rankLocations(this.names!, q), filter);
    return {
      matches: ranked.slice(0, limit).map((r) => r.record),
      total: ranked.length,
      snapshot,
      cached,
      scope: SCOPE,
    };
  }
  private async searchPaged(
    q: string,
    limit: number,
    filter?: SearchFilter,
  ): Promise<SearchResult> {
    const before = this.reader.requests;
    let readBytes = 0;
    const json = async (key: string) => {
      const bytes = await this.reader.block(key);
      readBytes += bytes.length;
      if (bytes.length > MAX_SEARCH_PAGE || readBytes > 64 * 1024 * 1024)
        throw new Error(
          "Search read budget reached. Add a more specific name or place.",
        );
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const catalogs = new Map<number, Term[]>();
    let chosen: Term | undefined;
    const namePrefix = this.catalog!.names && !q.includes(" ") ? "n:" : "",
      terms = new Map<string, Term>();
    for (const gram of queryGrams(q).map((g) => namePrefix + g)) {
      const bucket = termBucket(gram);
      if (!catalogs.has(bucket)) {
        const x = bucket >> 8,
          y = bucket & 255;
        const blocks = await this.reader.spatial("search/terms", 8, x, x, y, y);
        if (!blocks.length) return this.emptySearch(before);
        const data = await json(termKey(bucket));
        if (
          data.schema !== "terms-v1" ||
          !Array.isArray(data.terms) ||
          data.terms.length > 10000 ||
          !data.terms.every(
            (t: Term) =>
              typeof t.term === "string" &&
              t.term.length >= 1 &&
              t.term.length <= (t.term.startsWith("n:") ? 5 : 3) &&
              termBucket(t.term) === bucket &&
              Number.isSafeInteger(t.count) &&
              t.count > 0 &&
              t.count <= this.catalog!.records &&
              Number.isSafeInteger(t.start) &&
              t.start >= 0 &&
              t.start + t.pages <= 2 ** 32 &&
              t.pages === Math.ceil(t.count / POSTINGS_PER_PAGE),
          )
        )
          throw new Error("Invalid search term catalog");
        catalogs.set(bucket, data.terms);
      }
      const term = catalogs.get(bucket)!.find((t) => t.term === gram);
      if (!term) return this.emptySearch(before);
      terms.set(gram, term);
      if (!chosen || term.count < chosen.count) chosen = term;
    }
    if (!chosen) return this.emptySearch(before);
    // Broad terms are intersected as sorted streams. Each cursor holds one
    // posting page; the result and total decoded reads retain explicit budgets.
    const candidates = new Map<number, number[]>();
    let count = 0;
    const add = (id: number) => {
      if (++count > MAX_CANDIDATES)
        throw new Error(
          "This search is too broad. Add a more specific name or place.",
        );
      const page = Math.floor(id / RECORDS_PER_PAGE);
      let ids = candidates.get(page);
      if (!ids) candidates.set(page, (ids = []));
      ids.push(id % RECORDS_PER_PAGE);
    };
    const cursor = (term: Term) => {
      let page = 0,
        ids: number[] = [],
        offset = 0,
        previous = -1;
      return {
        value: -1,
        async seek(target: number): Promise<number> {
          while (true) {
            while (offset < ids.length && ids[offset]! < target) offset++;
            if (offset < ids.length) return (this.value = ids[offset]!);
            if (page >= term.pages) return (this.value = Infinity);
            const data = await json(ordinalKey("postings", term.start + page));
            if (
              data.schema !== "postings-v1" ||
              !Array.isArray(data.ids) ||
              data.ids.length !==
                Math.min(
                  POSTINGS_PER_PAGE,
                  term.count - page * POSTINGS_PER_PAGE,
                )
            )
              throw new Error("Invalid search postings");
            for (const id of data.ids) {
              if (!Number.isInteger(id) || id <= previous || id >= recordCount)
                throw new Error("Invalid search record reference");
              previous = id;
            }
            page++;
            ids = data.ids;
            offset = 0;
          }
        },
      };
    };
    const recordCount = this.catalog!.records;
    // Every query gram is a necessary condition, including for a single word.
    // Choosing just one can scatter false positives over thousands of record
    // pages and exhaust the byte budget far below MAX_CANDIDATES. Intersect
    // compact postings first; ranking still checks complete names and context.
    const selected = [
      ...new Map(
        [...terms.values()].map((t) => [`${t.start}/${t.count}/${t.pages}`, t]),
      ).values(),
    ].sort((a, b) => a.count - b.count);
    const streams = selected.map(cursor);
    let target = 0;
    outer: while (true) {
      let matched = true;
      for (const stream of streams) {
        const value = await stream.seek(target);
        if (!Number.isFinite(value)) break outer;
        if (value > target) {
          target = value;
          matched = false;
        }
      }
      if (matched) {
        add(target);
        target++;
      }
    }
    const matches: ReturnType<typeof locations> = [];
    for (const [page, ids] of candidates) {
      const bytes = await this.reader.block(ordinalKey("records", page));
      readBytes += bytes.length;
      if (bytes.length > MAX_SEARCH_PAGE || readBytes > 64 * 1024 * 1024)
        throw new Error(
          "Search read budget reached. Add a more specific name or place.",
        );
      const records = locations(bytes);
      if (
        records.length !==
        Math.min(
          RECORDS_PER_PAGE,
          this.catalog!.records - page * RECORDS_PER_PAGE,
        )
      )
        throw new Error("Search record page length mismatch");
      for (const id of ids) matches.push(records[id]!);
    }
    const ranked = filterLocations(rankLocations(matches, q), filter);
    return {
      matches: ranked.slice(0, limit).map((r) => r.record),
      total: ranked.length,
      snapshot: this.reader.index.manifest.snapshot,
      cached: before === this.reader.requests,
      scope: SCOPE,
    };
  }
  private emptySearch(before: number): SearchResult {
    return {
      matches: [],
      total: 0,
      snapshot: this.reader.index.manifest.snapshot,
      cached: before === this.reader.requests,
      scope: SCOPE,
    };
  }
  async reverse(point: Position): Promise<ReverseResult> {
    if (!validPosition(point))
      throw new Error("Invalid longitude/latitude coordinate");
    const cached = !!this.roads || this.reader.cache.has("search/streets");
    if (!this.roads && !this.pagedStreets) {
      this.pendingRoads ??= this.load("search/streets", "reverse-street")
        .then((bytes) => {
          const root = JSON.parse(new TextDecoder().decode(bytes));
          if (root.schema === "streets-paged-v1") {
            if (
              root.zoom !== STREET_ZOOM ||
              !Number.isSafeInteger(root.streets) ||
              root.streets < 0
            )
              throw new Error("Invalid paged street catalog");
            this.pagedStreets = true;
          } else this.roads = streets(bytes);
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
    const before = this.reader.requests;
    let roads = this.roads;
    if (this.pagedStreets) {
      const n = 2 ** STREET_ZOOM,
        a = project(Math.max(-180, point[0] - dx), Math.min(85, point[1] + dy)),
        b = project(Math.min(180, point[0] + dx), Math.max(-85, point[1] - dy));
      roads = [];
      const seen = new Set<string>();
      for (const cell of await this.reader.spatial(
        "search/streets-data",
        STREET_ZOOM,
        Math.max(0, Math.floor(a[0] * n)),
        Math.min(n - 1, Math.floor(b[0] * n)),
        Math.max(0, Math.floor(a[1] * n)),
        Math.min(n - 1, Math.floor(b[1] * n)),
      )) {
        for await (const bytes of readSearchCell(
          this.reader,
          cell.key,
          "streets",
          [point[0] - dx, point[1] - dy, point[0] + dx, point[1] + dy],
        ))
          for (const r of streets(bytes)) {
            const identity = r.street.id + JSON.stringify(r.street.coordinates);
            if (!seen.has(identity)) {
              seen.add(identity);
              roads.push(r);
            }
          }
      }
      roads.sort((a, b) =>
        a.street.id < b.street.id ? -1 : a.street.id > b.street.id ? 1 : 0,
      );
    }
    let match: ReverseResult["match"] = null;
    for (const {
      street,
      bounds: [w, s, e, n],
    } of roads!) {
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
      cached: this.pagedStreets
        ? cached && before === this.reader.requests
        : cached,
      scope: SCOPE,
    };
  }
}
