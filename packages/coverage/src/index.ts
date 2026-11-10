import { area } from "@turf/area";
import { intersect } from "@turf/intersect";
import { difference } from "@turf/difference";
import { union } from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  Polygon as GeoPolygon,
  MultiPolygon,
} from "geojson";
import { familyCatalog } from "../../format/src/families";
import { project, unproject, type Manifest } from "../../format/src/index";
import { graphIdentity } from "../../routing/src/composition";
import { validatePolygon, type Polygon } from "../../offline/src/geometry";
export type CoverageState =
  | "local"
  | "remote"
  | "unknown"
  | "incompatible"
  | "missing";
export interface CoverageSource {
  id: string;
  manifest: Manifest;
  location: "local" | "remote";
  verified: boolean;
  bytes: number;
  root?: string;
  publisher?: string;
  error?: string;
}
export interface CoverageRequest {
  polygon: Polygon;
  family: string;
  zoom: number;
  reference?: string;
  sourceIds?: string[];
}
type Shape = Feature<GeoPolygon | MultiPolygon>;
const collection = (
  features: Shape[],
): FeatureCollection<GeoPolygon | MultiPolygon> => ({
  type: "FeatureCollection",
  features,
});
const polygon = (p: Polygon): Shape => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[...p, p[0]!]] },
});
const box = ([w, s, e, n]: number[]): Shape =>
  polygon([
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]);
const merge = (a: Shape | null, b: Shape) =>
  a ? union(collection([a, b]))! : b;
const overlap = (a: Shape, b: Shape) => intersect(collection([a, b]));
const subtract = (a: Shape, b: Shape | null) =>
  b ? difference(collection([a, b])) : a;
export const COVERAGE_COLORS: Record<CoverageState, string> = {
  local: "#3b7d57",
  remote: "#347da7",
  unknown: "#a48739",
  incompatible: "#9a528d",
  missing: "#bf513c",
};
export function coverageFamilies(m: Manifest) {
  const families = familyCatalog(m);
  if (
    m.semantics?.addresses === "osm-explicit" &&
    m.capabilities.includes("location-search")
  )
    families.push({
      ...families.find((f) => f.id === "search")!,
      id: "addresses",
    });
  const features = families.find((f) => f.id === "features");
  if (features)
    for (const kind of m.featureKinds ?? [])
      if (kind !== "objects" && kind !== "boundaries")
        families.push({ ...features, id: `features:${kind}` });
  return families;
}
/** Archive scope, not real-world completeness or a proof of payload availability.
 * Priority partitions the request: local > remote > unknown > incompatible > missing.
 * Conflicting routing revisions remain listed even where a suitable provider exists. */
export function planCoverage(
  request: CoverageRequest,
  sources: CoverageSource[],
) {
  if (!Array.isArray(request.polygon)) throw Error("Choose a polygon area.");
  validatePolygon(request.polygon);
  if (
    request.polygon.some((p) => Math.abs(p[1]) > 85) ||
    !Number.isInteger(request.zoom) ||
    request.zoom < 0 ||
    request.zoom > 24 ||
    typeof request.family !== "string"
  )
    throw Error(
      "Choose a valid capability, zoom and area between 85°S and 85°N.",
    );
  const target = polygon(request.polygon),
    routing = request.family.startsWith("routing:");
  const candidates = sources.filter((s) =>
    coverageFamilies(s.manifest).some((f) => f.id === request.family),
  );
  const reference = request.reference
    ? sources.find((s) => s.id === request.reference)
    : (candidates.find((s) => s.verified && s.location === "local") ??
      candidates.find((s) => s.verified));
  if (request.reference && !reference)
    throw Error("Reference map is no longer available.");
  if (
    routing &&
    reference &&
    (!reference.verified ||
      !coverageFamilies(reference.manifest).some(
        (f) => f.id === request.family,
      ))
  )
    throw Error("Choose a verified reference with this routing profile.");
  const identity = reference && graphIdentity(reference.manifest);
  const shapes: Partial<Record<CoverageState, Shape>> = {},
    providers = [];
  for (const source of candidates) {
    const m = source.manifest,
      f = coverageFamilies(m).find((f) => f.id === request.family)!;
    const min =
      f.coverage.minZoom ??
      (request.family.startsWith("tile:") ? m.minZoom : undefined);
    const max =
      f.coverage.maxZoom ??
      (request.family.startsWith("tile:") ? m.maxZoom : undefined);
    if (min !== undefined && (request.zoom < min || request.zoom > max!))
      continue;
    let shape = overlap(target, box(f.coverage.bounds));
    if (shape && m.selection)
      shape = overlap(shape, polygon(m.selection.polygon));
    // Exclude partial edge cells. Selection padding is intentionally not credited here.
    if (shape && routing && m.transport?.federation) {
      const [w, s, e, n] = m.transport.federation.completeBounds,
        nw = project(w, n),
        se = project(e, s),
        z = 16384;
      const sw = unproject(
        (Math.floor(nw[0] * z) + 1) / z,
        (Math.ceil(se[1] * z) - 1) / z,
      );
      const ne = unproject(
        (Math.ceil(se[0] * z) - 1) / z,
        (Math.floor(nw[1] * z) + 1) / z,
      );
      shape =
        sw[0] < ne[0] && sw[1] < ne[1]
          ? overlap(shape, box([...sw, ...ne]))
          : null;
    }
    if (!shape) continue;
    const state: CoverageState = !source.verified
      ? "unknown"
      : routing && (!identity || graphIdentity(m) !== identity)
        ? "incompatible"
        : source.location;
    shapes[state] = merge(shapes[state] ?? null, shape);
    providers.push({
      id: source.id,
      name: m.name,
      state,
      bytes: source.bytes,
      root: source.root,
      publisher: source.publisher,
      snapshot: m.snapshot,
      routingIdentity: graphIdentity(m),
      error: source.error,
    });
  }
  let remaining: Shape | null = target;
  const regions: Array<
    Shape & { properties: { state: CoverageState; areaM2: number } }
  > = [];
  const totals: Record<CoverageState, number> = {
    local: 0,
    remote: 0,
    unknown: 0,
    incompatible: 0,
    missing: 0,
  };
  for (const state of [
    "local",
    "remote",
    "unknown",
    "incompatible",
    "missing",
  ] as const) {
    const shape: Shape | null =
      state === "missing"
        ? remaining
        : remaining && shapes[state]
          ? overlap(remaining, shapes[state]!)
          : null;
    if (!shape) continue;
    totals[state] = area(shape);
    regions.push({ ...shape, properties: { state, areaM2: totals[state] } });
    remaining = remaining ? subtract(remaining, shape) : null;
  }
  const unique = new Map<string, number>();
  for (const p of providers.filter((p) => p.state === "remote"))
    unique.set(p.root ?? p.id, p.bytes);
  return {
    version: 1 as const,
    checkedAt: new Date().toISOString(),
    request,
    reference: reference?.id,
    routingIdentity: identity,
    evidence: "verified-manifest-scope" as const,
    areaM2: area(target),
    totals,
    providers,
    fullArchiveDownloadBytes: [...unique.values()].reduce((a, b) => a + b, 0),
    regions: { type: "FeatureCollection" as const, features: regions },
    notes: [
      "Scope comes from archive metadata. It does not prove real-world completeness, route connectivity, or that every payload can currently be fetched.",
      "Missing means no matching offer among the sources checked here. Unknown sources may still cover it.",
      "Routing excludes partial edge cells and does not credit selection padding. Conflicts and empty cells need directory inspection.",
    ],
  };
}
export type CoverageReport = ReturnType<typeof planCoverage>;
