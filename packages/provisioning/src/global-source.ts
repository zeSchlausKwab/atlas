import { validBudget } from "./capacity";
import area from "@turf/area";
import difference from "@turf/difference";
import type { Feature, MultiPolygon, Polygon as GeoPolygon } from "geojson";
import {
  MAP_LAYERS,
  TRANSPORT_MODES,
  project,
  unproject,
} from "../../format/src/index";
import {
  FEATURE_KINDS,
  geometryBounds,
  type Bounds,
} from "../../features/src/index";
import {
  bounds,
  validatePolygon,
  type Polygon,
} from "../../offline/src/geometry";
import type { PackageSelection, SelectionScope } from "./selection";
export const WORLD_SOURCE: SelectionScope = {
  snapshot: "geofabrik",
  bounds: [-180, -85, 180, 85],
  minZoom: 0,
  maxZoom: 16,
  available: {
    layers: [...MAP_LAYERS],
    profiles: [...TRANSPORT_MODES],
    featureKinds: [...FEATURE_KINDS],
    labels: true,
    search: true,
    reverse: true,
    peaks: true,
  },
};
export interface SourceArea {
  polygon: Polygon;
  paddingCells: number;
  profiles: string[];
  maxSourceBytes: number;
}
export interface PbfRegion {
  id: string;
  name: string;
  url: string;
  geometry: GeoPolygon | MultiPolygon;
  bounds: Bounds;
  area: number;
}
export interface PbfPlan {
  id: string;
  provider: "geofabrik";
  region: { id: string; name: string; url: string };
  bytes: number;
  etag?: string;
  lastModified: string;
  expiresAt: number;
  area: SourceArea;
  bounds: Bounds;
}
export function validateSourceArea(v: unknown): asserts v is SourceArea {
  if (!v || typeof v !== "object") throw new Error("Draw an area first.");
  const a = v as SourceArea;
  if (!Array.isArray(a.polygon)) throw new Error("Draw an area first.");
  validatePolygon(a.polygon);
  if (a.polygon.some((p) => Math.abs(p[1]) > 85))
    throw new Error("Supported latitude range is −85° to 85°.");
  if (
    !Number.isInteger(a.paddingCells) ||
    a.paddingCells < 0 ||
    a.paddingCells > 4
  )
    throw new Error("Invalid routing padding.");
  if (
    !Array.isArray(a.profiles) ||
    a.profiles.some((p) => !TRANSPORT_MODES.includes(p as any)) ||
    new Set(a.profiles).size !== a.profiles.length
  )
    throw new Error("Invalid travel modes.");
  if (!validBudget(a.maxSourceBytes))
    throw new Error(
      "Enter a source download budget of at least 1 MiB, with an exact whole-byte value.",
    );
}
/** Import full z14 cells plus a one-cell guard; final preparation selects the requested polygon/cells. */
export function importBounds(a: SourceArea): Bounds {
  validateSourceArea(a);
  const b = bounds(a.polygon),
    nw = project(b[0], b[3]),
    se = project(b[2], b[1]),
    n = 16384,
    p = a.profiles.length ? a.paddingCells + 1 : 0;
  if (!p)
    return [
      Math.max(-180, b[0] - 0.0001),
      Math.max(-85, b[1] - 0.0001),
      Math.min(180, b[2] + 0.0001),
      Math.min(85, b[3] + 0.0001),
    ];
  const lo = unproject(
      Math.max(0, Math.floor(nw[0] * n) - p) / n,
      Math.min(n, Math.floor(se[1] * n) + p + 1) / n,
    ),
    hi = unproject(
      Math.min(n, Math.floor(se[0] * n) + p + 1) / n,
      Math.max(0, Math.floor(nw[1] * n) - p) / n,
    );
  return [lo[0], Math.max(-85, lo[1]), hi[0], Math.min(85, hi[1])];
}
export function allowedPbfUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "download.geofabrik.de" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/^\/[a-z0-9/_-]+\.osm\.pbf$/.test(u.pathname)
  )
    throw new Error("Untrusted PBF source URL");
  return u.href;
}
export function parseRegions(value: any): PbfRegion[] {
  if (value?.type !== "FeatureCollection" || !Array.isArray(value.features))
    throw new Error("Invalid Geofabrik catalog");
  return value.features.flatMap((f: any) => {
    if (
      !["Polygon", "MultiPolygon"].includes(f.geometry?.type) ||
      typeof f.properties?.id !== "string" ||
      typeof f.properties?.name !== "string" ||
      typeof f.properties?.urls?.pbf !== "string"
    )
      return [];
    const url = allowedPbfUrl(f.properties.urls.pbf),
      box = geometryBounds(f.geometry),
      size = area(f);
    if (!box.every(Number.isFinite) || !Number.isFinite(size) || size <= 0)
      throw new Error("Invalid catalog geometry");
    return [
      {
        id: f.properties.id,
        name: f.properties.name,
        url,
        geometry: f.geometry,
        bounds: box,
        area: size,
      },
    ];
  });
}
export function coveringRegion(regions: PbfRegion[], b: Bounds) {
  const box: Feature<GeoPolygon> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [b[0], b[1]],
          [b[2], b[1]],
          [b[2], b[3]],
          [b[0], b[3]],
          [b[0], b[1]],
        ],
      ],
    },
  };
  for (const r of [...regions]
    .filter(
      (r) =>
        r.bounds[0] <= b[0] &&
        r.bounds[1] <= b[1] &&
        r.bounds[2] >= b[2] &&
        r.bounds[3] >= b[3],
    )
    .sort((a, b) => a.area - b.area)) {
    // Corner tests alone miss concave gaps and holes in extract coverage.
    if (
      !difference({
        type: "FeatureCollection",
        features: [
          box,
          { type: "Feature", properties: {}, geometry: r.geometry },
        ],
      })
    )
      return r;
  }
  throw new Error(
    "No single Geofabrik extract covers this area and its routing padding. Select a smaller area; cross-region merging is not supported here yet.",
  );
}
export function planMatches(
  plan: PbfPlan,
  s: PackageSelection,
  maxSourceBytes: number,
) {
  return (
    JSON.stringify(plan.area.polygon) === JSON.stringify(s.polygon) &&
    plan.area.paddingCells === s.paddingCells &&
    !!plan.area.profiles.length === !!s.profiles.length &&
    plan.area.maxSourceBytes === maxSourceBytes
  );
}
