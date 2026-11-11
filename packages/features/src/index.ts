import { readObjects } from "../../objects/src/index";
import { readBoundaries } from "../../boundaries/src/index";
import { readFeatureCell } from "./pages";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { AtlasReader } from "../../format/src/reader";
import { project } from "../../format/src/index";
export const FEATURE_ZOOM = 12;
export const LEGACY_FEATURE_KINDS = [
  "buildings",
  "water",
  "railways",
  "roads",
  "land",
] as const;
export const FEATURE_KINDS = [
  ...LEGACY_FEATURE_KINDS,
  "boundaries",
  "objects",
] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];
export type Bounds = [number, number, number, number];
export type MapFeature = Feature<
  Geometry,
  { id: string; name: string; kind: FeatureKind; tags: Record<string, string> }
> & { id: string; bbox: Bounds };
export interface FeatureQuery {
  kind: FeatureKind;
  bounds: Bounds;
  limit?: number;
  tag?: string;
}
export interface FeatureResult
  extends FeatureCollection<Geometry, MapFeature["properties"]> {
  features: MapFeature[];
  snapshot: string;
  truncated: boolean;
  matched: number;
  attribution: string;
}
export function geometryBounds(geometry: Geometry): Bounds {
  const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (v: any): void => {
    if (Array.isArray(v) && typeof v[0] === "number") {
      box[0] = Math.min(box[0], v[0]);
      box[1] = Math.min(box[1], v[1]);
      box[2] = Math.max(box[2], v[0]);
      box[3] = Math.max(box[3], v[1]);
    } else if (Array.isArray(v)) v.forEach(visit);
  };
  if (geometry.type === "GeometryCollection")
    for (const g of geometry.geometries) {
      const b = geometryBounds(g);
      visit([b[0], b[1]]);
      visit([b[2], b[3]]);
    }
  else visit(geometry.coordinates);
  return box;
}
export function validateFeatureQuery(q: FeatureQuery) {
  const b = q?.bounds;
  if (
    !FEATURE_KINDS.includes(q?.kind) ||
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    b[0] >= b[2] ||
    b[1] >= b[3] ||
    b[0] < -180 ||
    b[2] > 180 ||
    b[1] < -85 ||
    b[3] > 85
  )
    throw new Error("Invalid feature query bounds or category");
  if (
    !["boundaries", "objects"].includes(q.kind) &&
    (b[2] - b[0] > 0.25 || b[3] - b[1] > 0.25)
  )
    throw new Error("Zoom in to extract an area smaller than 0.25° across.");
  if (
    q.limit !== undefined &&
    (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 500)
  )
    throw new Error("Feature limit must be 1–500");
  if (
    q.tag !== undefined &&
    q.tag !== "" &&
    !/^[\w:.-]+=[^=\n]{1,100}$/.test(q.tag)
  )
    throw new Error("Use an OSM tag such as water=lake or railway=tram.");
}
const overlap = (a: Bounds, b: Bounds) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function inRing(p: Position, ring: Position[]) {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (
      a[1]! > p[1]! !== b[1]! > p[1]! &&
      p[0]! < ((b[0]! - a[0]!) * (p[1]! - a[1]!)) / (b[1]! - a[1]!) + a[0]!
    )
      yes = !yes;
  }
  return yes;
}
function segmentHits(a: Position, b: Position, r: Bounds) {
  let lo = 0,
    hi = 1;
  for (const k of [0, 1]) {
    const d = b[k]! - a[k]!;
    if (Math.abs(d) < 1e-14) {
      if (a[k]! < r[k]! || a[k]! > r[k + 2]!) return false;
    } else {
      let t0 = (r[k]! - a[k]!) / d,
        t1 = (r[k + 2]! - a[k]!) / d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      lo = Math.max(lo, t0);
      hi = Math.min(hi, t1);
      if (lo > hi) return false;
    }
  }
  return true;
}
export function geometryIntersects(g: Geometry, b: Bounds): boolean {
  const line = (p: Position[]) =>
    p.some((v, i) => i > 0 && segmentHits(p[i - 1]!, v, b));
  const polygon = (p: Position[][]) =>
    p.some(line) ||
    (inRing([b[0], b[1]], p[0]!) &&
      !p.slice(1).some((r) => inRing([b[0], b[1]], r)));
  switch (g.type) {
    case "Polygon":
      return polygon(g.coordinates);
    case "MultiPolygon":
      return g.coordinates.some(polygon);
    case "LineString":
      return line(g.coordinates);
    case "MultiLineString":
      return g.coordinates.some(line);
    default:
      return false;
  }
}
export function decodeFeatures(bytes: Uint8Array): MapFeature[] {
  return validateFeatures(JSON.parse(new TextDecoder().decode(bytes)));
}
export function validateFeatures(data: any): MapFeature[] {
  let points = 0;
  const coords = (v: any): boolean =>
    Array.isArray(v) &&
    v.length > 0 &&
    (typeof v[0] === "number"
      ? ++points <= 3_000_000 &&
        v.length === 2 &&
        Number.isFinite(v[0]) &&
        Number.isFinite(v[1]) &&
        Math.abs(v[0]) <= 180 &&
        Math.abs(v[1]) <= 85
      : v.every(coords));
  if (
    data?.schema !== "features-v1" ||
    !Array.isArray(data.features) ||
    data.features.length > 100000 ||
    !data.features.every(
      (f: any) =>
        f?.type === "Feature" &&
        typeof f.id === "string" &&
        (/^(way|relation)\/\d+$/.test(f.id) ||
          (f.properties?.kind === "boundaries" &&
            /^natural-earth\/admin-0\/\d+$/.test(f.id))) &&
        f.properties?.id === f.id &&
        FEATURE_KINDS.includes(f.properties.kind) &&
        typeof f.properties.name === "string" &&
        f.properties.tags &&
        typeof f.properties.tags === "object" &&
        !Array.isArray(f.properties.tags) &&
        Object.values(f.properties.tags).every((v) => typeof v === "string") &&
        ["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(
          f.geometry?.type,
        ) &&
        coords(f.geometry.coordinates) &&
        Array.isArray(f.bbox) &&
        f.bbox.length === 4 &&
        f.bbox.every(Number.isFinite),
    )
  )
    throw new Error("Invalid feature geometry block");
  return data.features;
}
export class AtlasFeatures {
  constructor(readonly reader: AtlasReader) {}
  async *scan(
    q: FeatureQuery,
    signal?: AbortSignal,
  ): AsyncGenerator<MapFeature> {
    validateFeatureQuery(q);
    const m = this.reader.index.manifest;
    if (!m.capabilities.includes("feature-extraction"))
      throw new Error(
        "This package has no selectable source geometry. Generate it with --features.",
      );
    if (m.featureKinds && !m.featureKinds.includes(q.kind))
      throw new Error(
        `This package does not contain ${q.kind} source features.`,
      );
    if (q.kind === "objects") {
      const [key, value] = q.tag?.split("=") ?? [];
      for await (const f of readObjects(
        this.reader,
        q.bounds,
        true,
        signal,
        () => true,
        undefined,
        key ? { tag: { key, value } } : {},
      ))
        yield f as MapFeature;
      return;
    }
    if (q.kind === "boundaries") {
      for await (const f of readBoundaries(
        this.reader,
        q.bounds,
        true,
        signal,
      )) {
        const [key, value] = q.tag?.split("=") ?? [];
        if (!key || f.properties.tags[key] === value) yield f as MapFeature;
      }
      return;
    }
    const z = m.featureZoom!,
      n = 2 ** z,
      nw = project(q.bounds[0], q.bounds[3]),
      se = project(q.bounds[2], q.bounds[1]);
    const blocks = await this.reader.spatial(
      `features/${q.kind}`,
      z,
      Math.floor(nw[0] * n),
      Math.floor(se[0] * n),
      Math.floor(nw[1] * n),
      Math.floor(se[1] * n),
    );
    const seen = new Set<string>();
    let scanned = 0;
    const [key, value] = q.tag?.split("=") ?? [];
    const budget = { remaining: 64 * 1024 ** 2 };
    for (const b of blocks) {
      for await (const row of readFeatureCell(
        this.reader,
        b.key,
        q.bounds,
        true,
        signal,
        budget,
      )) {
        const { geometryHash: _hash, ...f } = row as MapFeature & {
          geometryHash?: string;
        };
        if (
          seen.has(f.id) ||
          f.properties.kind !== q.kind ||
          (key && f.properties.tags[key] !== value)
        )
          continue;
        seen.add(f.id);
        if (++scanned > 100000)
          throw new Error(
            "Feature scan exceeds 100,000 objects; select a smaller area.",
          );
        yield f;
      }
    }
  }

  async query(q: FeatureQuery, signal?: AbortSignal): Promise<FeatureResult> {
    const found: MapFeature[] = [];
    for await (const f of this.scan(q, signal)) found.push(f);
    const m = this.reader.index.manifest;
    const all = found.sort((a, b) => a.id.localeCompare(b.id)),
      limit = q.limit ?? 200;
    return {
      type: "FeatureCollection",
      features: all.slice(0, limit),
      matched: all.length,
      truncated: all.length > limit,
      snapshot: m.snapshot,
      attribution: m.source.attribution,
    };
  }
}
/** Polygon boundaries become MultiLineStrings, including courtyard rings. Lines retain their geometry. */
export function asPolylines(features: MapFeature[]): MapFeature[] {
  return features.map((f) => ({
    ...f,
    geometry:
      f.geometry.type === "Polygon"
        ? { type: "MultiLineString", coordinates: f.geometry.coordinates }
        : f.geometry.type === "MultiPolygon"
          ? {
              type: "MultiLineString",
              coordinates: f.geometry.coordinates.flat(),
            }
          : f.geometry,
  }));
}
