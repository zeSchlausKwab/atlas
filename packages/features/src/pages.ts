import type { Geometry } from "geojson";
import { sha256, spatialAddress } from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import {
  decodeFeatures,
  validateFeatures,
  geometryIntersects,
  type Bounds,
  type MapFeature,
} from "./index";

export const MAX_FEATURE_PAGE = 4 * 1024 ** 2;
export const FEATURE_PAGE_TARGET = 256 * 1024;
export interface FeaturePage {
  attributes: string;
  geometry: string;
  bounds: Bounds;
  count: number;
}
export interface FeatureCatalog {
  schema: "features-paged-v2";
  pages: FeaturePage[];
}
export type FeatureRecord = Omit<MapFeature, "geometry"> & {
  geometry?: Geometry;
  geometryHash?: string;
};
export const overlaps = (a: Bounds, b: Bounds) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const contains = (a: Bounds, b: Bounds) =>
  a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
export const featureJSON = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
export const geometryHash = (geometry: Geometry) =>
  sha256(
    featureJSON(
      geometry.type === "GeometryCollection"
        ? { type: geometry.type, geometries: geometry.geometries }
        : { type: geometry.type, coordinates: geometry.coordinates },
    ),
  );
/** Ordinal addresses use bounded archive directory leaves, not geographic coordinates. */
export function featurePageKey(
  type: "attributes" | "geometry",
  ordinal: number,
) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 2 ** 32)
    throw new Error("Feature page ordinal overflow");
  const leaf = Math.floor(ordinal / 1024),
    slot = ordinal % 1024;
  return `features/${type}/16/${(leaf % 2048) * 32 + Math.floor(slot / 32)}/${Math.floor(leaf / 2048) * 32 + (slot % 32)}`;
}
const pageKeyValid = (key: unknown, type: string) =>
  typeof key === "string" &&
  new RegExp(`^features/${type}/16/\\d+/\\d+$`).test(key) &&
  key
    .split("/")
    .slice(-2)
    .every((v) => Number(v) < 65536);
const boundsValid = (b: unknown): b is Bounds =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] <= b[2] &&
  b[1] <= b[3] &&
  b[0] >= -180 &&
  b[2] <= 180 &&
  b[1] >= -85 &&
  b[3] <= 85;
export function featureCatalog(bytes: Uint8Array): FeatureCatalog | null {
  if (bytes.length > MAX_FEATURE_PAGE)
    throw new Error("Feature catalog exceeds 4 MiB");
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (data?.schema === "features-v1") return null;
  if (
    data?.schema !== "features-paged-v2" ||
    !Array.isArray(data.pages) ||
    data.pages.length > 10000 ||
    !data.pages.every(
      (p: FeaturePage) =>
        p &&
        pageKeyValid(p.attributes, "attributes") &&
        pageKeyValid(p.geometry, "geometry") &&
        boundsValid(p.bounds) &&
        Number.isSafeInteger(p.count) &&
        p.count > 0 &&
        p.count <= 128,
    ) ||
    new Set(data.pages.map((p: FeaturePage) => p.attributes)).size !==
      data.pages.length ||
    new Set(data.pages.map((p: FeaturePage) => p.geometry)).size !==
      data.pages.length
  )
    throw new Error("Invalid feature page catalog");
  return data;
}
export function featureAttributes(bytes: Uint8Array): FeatureRecord[] {
  if (bytes.length > MAX_FEATURE_PAGE)
    throw new Error("Feature attribute page exceeds 4 MiB");
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (
    data?.schema !== "feature-attributes-v2" ||
    !Array.isArray(data.features) ||
    data.features.length > 128
  )
    throw new Error("Invalid feature attributes");
  // Reuse the geometry block's attribute validation, with a cheap placeholder shape.
  validateFeatures({
    schema: "features-v1",
    features: data.features.map((f: FeatureRecord) => ({
      ...f,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0, 0],
        ],
      },
    })),
  });
  if (
    !data.features.every(
      (f: FeatureRecord) =>
        boundsValid(f.bbox) &&
        !Object.hasOwn(f, "geometry") &&
        typeof f.geometryHash === "string" &&
        /^[a-f0-9]{64}$/.test(f.geometryHash),
    ) ||
    new Set(data.features.map((f: FeatureRecord) => f.id)).size !==
      data.features.length
  )
    throw new Error("Invalid feature attribute identity or bounds");
  return data.features;
}
export async function featureBlock(reader: AtlasReader, key: string) {
  const a = spatialAddress(key);
  const b = a
    ? (await reader.spatial(a.prefix, a.z, a.x, a.x, a.y, a.y)).find(
        (b) => b.key === key,
      )
    : reader.index.blocks.find((b) => b.key === key);
  if (!b) throw new Error(`Missing feature page ${key}`);
  return b;
}
/** Exact intersection. Attribute-only reads fetch geometry only for boundary candidates.
 * exactId resolves a search anchor's source object, including when the anchor falls
 * in a polygon hole. Bounds still prune index pages; they are not an area filter
 * in that mode. The caller must provide a source-backed ID, never a name match.
 */
export async function* readFeatureCell(
  reader: AtlasReader,
  key: string,
  bounds: Bounds,
  includeGeometry = true,
  signal?: AbortSignal,
  budget?: { remaining: number },
  exactId?: string,
): AsyncGenerator<FeatureRecord> {
  signal?.throwIfAborted();
  const read = async (key: string) => {
    signal?.throwIfAborted();
    if (budget) {
      const b = await featureBlock(reader, key),
        size = b.rawLength ?? b.length;
      if (size > budget.remaining)
        throw new Error("Feature scan exceeds 64 MiB; select a smaller area.");
      budget.remaining -= size;
    }
    return reader.block(key);
  };
  const root = await read(key);
  // Legacy large cells remain readable, under the caller's existing budgets.
  const data = JSON.parse(new TextDecoder().decode(root));
  if (data?.schema === "features-v1") {
    for (const f of decodeFeatures(root)) {
      signal?.throwIfAborted();
      if (
        exactId
          ? f.id !== exactId
          : !overlaps(f.bbox, bounds) || !geometryIntersects(f.geometry, bounds)
      )
        continue;
      if (includeGeometry) yield f;
      else {
        const { geometry, ...row } = f;
        yield { ...row, geometryHash: await geometryHash(geometry) };
      }
    }
    return;
  }
  const catalog = featureCatalog(root)!;
  for (const page of catalog.pages) {
    signal?.throwIfAborted();
    if (!overlaps(page.bounds, bounds)) continue;
    const rows = featureAttributes(await read(page.attributes));
    if (
      rows.length !== page.count ||
      rows.some((r) => !contains(page.bounds, r.bbox))
    )
      throw new Error("Feature page metadata mismatch");
    const candidates = rows.filter((r) =>
      exactId ? r.id === exactId : overlaps(r.bbox, bounds),
    );
    if (!candidates.length) continue;
    let geometries: Map<string, Geometry> | undefined;
    if (includeGeometry || candidates.some((r) => !contains(bounds, r.bbox))) {
      const bytes = await read(page.geometry);
      if (bytes.length > MAX_FEATURE_PAGE)
        throw new Error("Feature geometry page exceeds 4 MiB");
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (
        value?.schema !== "feature-geometry-v2" ||
        !Array.isArray(value.features) ||
        value.features.length !== rows.length ||
        value.features.some(
          (f: { id: string }, i: number) => f?.id !== rows[i]!.id,
        )
      )
        throw new Error("Invalid feature geometry page");
      const full = validateFeatures({
        schema: "features-v1",
        features: rows.map((r, i) => ({
          ...r,
          geometry: value.features[i].geometry,
        })),
      });
      geometries = new Map();
      for (let i = 0; i < full.length; i++) {
        const f = full[i]!;
        if ((await geometryHash(f.geometry)) !== rows[i]!.geometryHash)
          throw new Error("Feature geometry identity mismatch");
        geometries.set(f.id, f.geometry);
      }
    }
    for (const row of candidates) {
      signal?.throwIfAborted();
      const geometry = geometries?.get(row.id);
      if (
        !exactId &&
        !contains(bounds, row.bbox) &&
        (!geometry || !geometryIntersects(geometry, bounds))
      )
        continue;
      yield includeGeometry ? { ...row, geometry: geometry! } : row;
    }
  }
}
