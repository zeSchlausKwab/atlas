import type { Geometry } from "geojson";
export type Box = [number, number, number, number];
export interface SourceObject {
  id: string;
  tags: Record<string, string>;
  geometry: Geometry | null;
  geometryStatus:
    | "complete"
    | "missing-nodes"
    | "incomplete-area"
    | "relation-members";
  nodeRefs?: string[];
  members?: { id: string; role: string; coordinates?: [number, number] }[];
  unavailableMembers?: string[];
  dependencyOnly?: boolean;
}
export interface ObjectRecord {
  id: string;
  name: string;
  tags: Record<string, string>;
  facets: string[];
  bounds: Box[];
  geometryStatus: SourceObject["geometryStatus"];
  geometry?: { blocks: string[]; bytes: number };
  topology?: { blocks: string[]; bytes: number };
  dependencyOnly: boolean;
}
export interface Page {
  unlocated: boolean;
  key: string;
  bounds: Box[];
  keys: string[];
  facets: string[];
  count: number;
  min?: string;
  max?: string;
}
export interface ObjectCatalog {
  schema: "source-objects-v1";
  count: number;
  spatial: Page;
  lookup: Page;
  report: RetentionReport;
}
export interface RetentionReport {
  schema: "retention-v1";
  profile:
    | "tagged-objects-and-way-dependencies"
    | "derived-surfaces"
    | "selected-objects";
  counts: Record<string, number>;
  geometryStatus: Record<string, number>;
  facets: Record<string, number>;
  tagKeys: Record<string, number>;
  encountered: Record<string, number>;
  omitted: Record<string, number>;
  geometryBytes: number;
  topologyBytes: number;
  metadataBytes: number;
  scope: string;
  realWorldCompleteness: "unknown";
  limitations: string[];
}
export const objectId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^(?:(node|way|relation)\/[0-9]+|external\/[a-z0-9-]+\/[a-zA-Z0-9_-]+)$/.test(
    v,
  );
export const encode = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v));
export function facets(t: Record<string, string>) {
  const f = new Set<string>();
  if (t.building || t["building:part"]) f.add("buildings");
  if (t.boundary === "administrative") f.add("boundaries");
  if (t.natural === "coastline") f.add("coastline");
  if (t.natural === "water" || t.waterway || t.water) f.add("water");
  if (t.highway) f.add("roads");
  if (t.railway) f.add("railways");
  if (t.landuse || t.landcover || t.natural || t.leisure) f.add("land");
  if (
    t.boundary === "protected_area" ||
    t.boundary === "national_park" ||
    t.protect_class
  )
    f.add("protected-areas");
  if (t.entrance || t.barrier || t.crossing) f.add("access");
  if (t.power || t.man_made) f.add("infrastructure");
  if (t.route || t.public_transport || t.type === "route_master")
    f.add("transport");
  if (
    t.harbour ||
    t.harbor ||
    t.seamark ||
    Object.keys(t).some((k) => k.startsWith("seamark:"))
  )
    f.add("marine");
  if (t["addr:housenumber"] || t["addr:interpolation"]) f.add("addresses");
  if (
    [
      "amenity",
      "shop",
      "office",
      "tourism",
      "healthcare",
      "craft",
      "historic",
    ].some((k) => t[k])
  )
    f.add("sites");
  return [...f].sort();
}
export const overlap = (a: Box, b: Box) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const boxValid = (b: unknown): b is Box =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -180 &&
  b[2] <= 180 &&
  b[1] >= -90 &&
  b[3] <= 90 &&
  b[0] <= b[2] &&
  b[1] <= b[3];
export function splitBounds(b: Box): Box[] {
  if (
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    Math.abs(b[0]) > 180 ||
    Math.abs(b[2]) > 180 ||
    b[1] < -90 ||
    b[3] > 90 ||
    b[1] > b[3]
  )
    throw new Error("Invalid WGS84 bounds");
  return b[0] <= b[2]
    ? [b]
    : [
        [b[0], b[1], 180, b[3]],
        [-180, b[1], b[2], b[3]],
      ];
}
export function geometryBounds(g: Geometry): Box[] {
  const boxes: Box[] = [];
  const line = (points: number[][]) => {
    let prev = points[0]?.[0] ?? 0,
      min = Infinity,
      max = -Infinity,
      s = Infinity,
      n = -Infinity;
    for (const p of points) {
      if (
        p.length < 2 ||
        !p.every(Number.isFinite) ||
        Math.abs(p[0]!) > 180 ||
        Math.abs(p[1]!) > 90
      )
        throw new Error("Invalid WGS84 geometry");
      let x = p[0]!;
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
      prev = x;
      min = Math.min(min, x);
      max = Math.max(max, x);
      s = Math.min(s, p[1]!);
      n = Math.max(n, p[1]!);
    }
    if (!Number.isFinite(min)) throw new Error("Empty source geometry");
    if (max - min >= 360) {
      boxes.push([-180, s, 180, n]);
      return;
    }
    while (min < -180) {
      min += 360;
      max += 360;
    }
    while (min > 180) {
      min -= 360;
      max -= 360;
    }
    boxes.push(
      ...(max > 180
        ? ([
            [min, s, 180, n],
            [-180, s, max - 360, n],
          ] as Box[])
        : ([[min, s, max, n]] as Box[])),
    );
  };
  const walk = (v: Geometry): void => {
    switch (v.type) {
      case "Point":
        line([v.coordinates]);
        break;
      case "MultiPoint":
        v.coordinates.forEach((x) => line([x]));
        break;
      case "LineString":
        line(v.coordinates);
        break;
      case "MultiLineString":
      case "Polygon":
        v.coordinates.forEach(line);
        break;
      case "MultiPolygon":
        v.coordinates.forEach((p) => p.forEach(line));
        break;
      case "GeometryCollection":
        v.geometries.forEach(walk);
        break;
      default:
        throw new Error("Unknown geometry type");
    }
  };
  walk(g);
  return boxes;
}
export const archiveKey = (kind: string, n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 2 ** 52)
    throw new Error("Object block ordinal overflow");
  const leaf = Math.floor(n / 1024),
    slot = n % 1024;
  return `objects/${kind}/26/${(leaf % 2 ** 21) * 32 + Math.floor(slot / 32)}/${Math.floor(leaf / 2 ** 21) * 32 + (slot % 32)}`;
};
export const validKey = (v: unknown) =>
  typeof v === "string" &&
  /^objects\/[a-z-]+\/26\/[0-9]+\/[0-9]+$/.test(v) &&
  v
    .split("/")
    .slice(-2)
    .every((n) => Number(n) < 2 ** 26);
