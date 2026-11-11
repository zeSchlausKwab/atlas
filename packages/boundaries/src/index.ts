import type { Feature, Polygon, MultiPolygon } from "geojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { AtlasReader } from "../../format/src/reader";
import {
  geometryBounds,
  geometryIntersects,
  validateFeatures,
  type Bounds,
  type MapFeature,
} from "../../features/src/index";
import { overlaps } from "../../features/src/pages";
import { type Location } from "../../geocoding/src/model";
export const BOUNDARY_ROOT = "boundaries/index";
export interface BoundaryRecord {
  id: string;
  name: string;
  tags: Record<string, string>;
  bbox: Bounds;
  coordinates: [number, number];
  relatedIds: string[];
  geometry: string;
}
export interface BoundaryPage {
  key: string;
  bbox: Bounds;
  count: number;
}
export interface BoundaryCatalog {
  schema: "boundaries-v1";
  count: number;
  pages: BoundaryPage[];
}
export const boundaryKey = (
  family: "records" | "geometry",
  ordinal: number,
) => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 2 ** 32)
    throw new Error("Boundary ordinal overflow");
  const leaf = Math.floor(ordinal / 1024),
    slot = ordinal % 1024;
  return `boundaries/${family}/16/${(leaf % 2048) * 32 + Math.floor(slot / 32)}/${Math.floor(leaf / 2048) * 32 + (slot % 32)}`;
};
const keyValid = (key: unknown, family: string) =>
  typeof key === "string" &&
  new RegExp(`^boundaries/${family}/16/\\d+/\\d+$`).test(key) &&
  key
    .split("/")
    .slice(-2)
    .every((n) => Number(n) < 65536);
const bboxValid = (b: unknown): b is Bounds =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -180 &&
  b[2] <= 180 &&
  b[1] >= -85 &&
  b[3] <= 85 &&
  b[0] <= b[2] &&
  b[1] <= b[3];
const idValid = (id: unknown) =>
  typeof id === "string" &&
  /^(?:(?:node|way|relation)\/\d+|natural-earth\/admin-0\/\d+)$/.test(id);
const contains = (outer: Bounds, inner: Bounds) =>
  outer[0] <= inner[0] &&
  outer[1] <= inner[1] &&
  outer[2] >= inner[2] &&
  outer[3] >= inner[3];
export function validateBoundary(f: MapFeature) {
  if (
    !["Polygon", "MultiPolygon"].includes(f.geometry.type) ||
    f.properties.kind !== "boundaries" ||
    f.properties.tags.boundary !== "administrative"
  )
    throw new Error("Invalid administrative boundary");
  const g = f.geometry as Polygon | MultiPolygon,
    polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  if (
    polygons.some(
      (p) =>
        !p.length ||
        p.some(
          (r) =>
            r.length < 4 ||
            r[0]![0] !== r.at(-1)![0] ||
            r[0]![1] !== r.at(-1)![1],
        ),
    )
  )
    throw new Error("Unclosed administrative boundary ring");
}
export const hasBoundaries = (r: AtlasReader) =>
  r.index.manifest.capabilities.includes("administrative-boundaries");
export async function boundaryCatalog(
  r: AtlasReader,
): Promise<BoundaryCatalog> {
  if (!hasBoundaries(r))
    throw new Error(
      "This archive has no administrative boundaries. Its place-name points do not establish administrative areas.",
    );
  const v = JSON.parse(new TextDecoder().decode(await r.block(BOUNDARY_ROOT)));
  if (
    v?.schema !== "boundaries-v1" ||
    !Number.isSafeInteger(v.count) ||
    v.count < 0 ||
    !Array.isArray(v.pages) ||
    v.pages.some(
      (p: BoundaryPage) =>
        !p ||
        !keyValid(p.key, "records") ||
        !bboxValid(p.bbox) ||
        !Number.isInteger(p.count) ||
        p.count < 1 ||
        p.count > 256,
    ) ||
    v.pages.reduce((n: number, p: BoundaryPage) => n + p.count, 0) !==
      v.count ||
    new Set(v.pages.map((p: BoundaryPage) => p.key)).size !== v.pages.length
  )
    throw new Error("Invalid boundary catalog");
  return v;
}
export async function* boundaryRecords(
  r: AtlasReader,
  bounds?: Bounds,
  signal?: AbortSignal,
  progress: (message: string) => void = () => {},
) {
  const catalog = await boundaryCatalog(r);
  let done = 0;
  const pages = catalog.pages.filter(
    (p) => !bounds || overlaps(bounds, p.bbox),
  );
  for (const page of pages) {
    signal?.throwIfAborted();
    const bytes = await r.block(page.key);
    if (bytes.length > 1024 ** 2)
      throw new Error("Boundary metadata page exceeds 1 MiB");
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (
      data?.schema !== "boundary-records-v1" ||
      !Array.isArray(data.records) ||
      data.records.length !== page.count ||
      data.records.some(
        (v: BoundaryRecord) =>
          !v ||
          !idValid(v.id) ||
          typeof v.name !== "string" ||
          !bboxValid(v.bbox) ||
          !contains(page.bbox, v.bbox) ||
          !keyValid(v.geometry, "geometry") ||
          !Array.isArray(v.relatedIds) ||
          !v.relatedIds.every(idValid) ||
          !Array.isArray(v.coordinates) ||
          v.coordinates.length !== 2 ||
          !v.coordinates.every(Number.isFinite) ||
          Math.abs(v.coordinates[0]) > 180 ||
          Math.abs(v.coordinates[1]) > 85 ||
          !v.tags ||
          v.tags.boundary !== "administrative" ||
          Object.values(v.tags).some((x) => typeof x !== "string"),
      ) ||
      new Set(data.records.map((v: BoundaryRecord) => v.id)).size !==
        data.records.length
    )
      throw new Error("Invalid boundary metadata page");
    for (const record of data.records as BoundaryRecord[])
      if (!bounds || overlaps(bounds, record.bbox)) yield record;
    progress(
      `Reading administrative areas · ${++done}/${pages.length} metadata pages`,
    );
  }
}
export async function boundaryFeature(
  r: AtlasReader,
  record: BoundaryRecord,
): Promise<MapFeature> {
  const data = JSON.parse(
    new TextDecoder().decode(await r.block(record.geometry)),
  );
  const [f] = validateFeatures(data);
  if (
    data.features.length !== 1 ||
    !f ||
    f.id !== record.id ||
    f.properties.kind !== "boundaries" ||
    !["Polygon", "MultiPolygon"].includes(f.geometry.type) ||
    JSON.stringify(geometryBounds(f.geometry)) !== JSON.stringify(record.bbox)
  )
    throw new Error("Boundary geometry does not match its metadata");
  validateBoundary(f);
  if (
    f.properties.name !== record.name ||
    JSON.stringify(Object.entries(f.properties.tags).sort()) !==
      JSON.stringify(Object.entries(record.tags).sort())
  )
    throw new Error("Boundary attributes do not match metadata");
  return f;
}
export async function* readBoundaries(
  r: AtlasReader,
  bounds: Bounds,
  geometry = true,
  signal?: AbortSignal,
  predicate: (f: Omit<MapFeature, "geometry">) => boolean = () => true,
  progress?: (s: string) => void,
) {
  for await (const row of boundaryRecords(r, bounds, signal, progress)) {
    const f = {
      type: "Feature" as const,
      id: row.id,
      bbox: row.bbox,
      properties: {
        id: row.id,
        name: row.name,
        kind: "boundaries" as const,
        tags: row.tags,
      },
    };
    if (!predicate(f)) continue;
    const contained =
      row.bbox[0] >= bounds[0] &&
      row.bbox[1] >= bounds[1] &&
      row.bbox[2] <= bounds[2] &&
      row.bbox[3] <= bounds[3];
    const full =
      geometry || !contained ? await boundaryFeature(r, row) : undefined;
    signal?.throwIfAborted();
    if (full && !geometryIntersects(full.geometry, bounds)) continue;
    yield { ...f, ...(geometry ? { geometry: full!.geometry } : {}) };
  }
}
export async function findBoundary(
  r: AtlasReader,
  id: string,
  signal?: AbortSignal,
) {
  const linked: BoundaryRecord[] = [];
  for await (const row of boundaryRecords(r, undefined, signal)) {
    if (row.id === id) return boundaryFeature(r, row);
    if (row.relatedIds.includes(id)) linked.push(row);
  }
  if (linked.length > 1)
    throw new Error(
      `Place ${id} links to multiple administrative areas. Use boundary_search and choose an exact relation ID.`,
    );
  if (linked[0]) return boundaryFeature(r, linked[0]);
}
export function boundaryLocation(row: BoundaryRecord): Location {
  return {
    id: row.id,
    name: row.name || "Unnamed administrative area",
    aliases: [
      ...new Set(
        Object.entries(row.tags)
          .filter(
            ([k]) =>
              k.startsWith("name:") ||
              ["alt_name", "short_name", "official_name"].includes(k),
          )
          .flatMap(([, v]) => v.split(";")),
      ),
    ],
    kind: "place",
    category: "administrative",
    coordinates: row.coordinates,
    tags: row.tags,
    context: row.tags["is_in"],
  };
}
export async function containingBoundaries(
  r: AtlasReader,
  point: [number, number],
  signal?: AbortSignal,
) {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !point.every(Number.isFinite) ||
    Math.abs(point[0]) > 180 ||
    Math.abs(point[1]) > 85
  )
    throw new Error("Invalid longitude/latitude");
  const features: MapFeature[] = [];
  for await (const row of boundaryRecords(r, [...point, ...point], signal)) {
    const f = await boundaryFeature(r, row);
    if (booleanPointInPolygon(point, f as Feature<Polygon | MultiPolygon>))
      features.push(f);
  }
  return {
    type: "FeatureCollection" as const,
    features,
    scope: "retained-source-data",
    realWorldCompleteness: "unknown",
    hierarchy:
      "Not inferred from numeric admin_level; levels are country-specific.",
  };
}
