import area from "@turf/area";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import union from "@turf/union";
import valid from "@turf/boolean-valid";
import type { FeatureCollection } from "geojson";
import {
  fc,
  polygon,
  rect,
  validBounds,
  boundsOf,
  BoxTree,
  type Surface,
  type Bounds,
} from "./index";
import { checkpoint } from "./construction";
/** Checks are measured against retained geometry, never a claim of real-world coverage. */
export async function checkPolygons(
  source: FeatureCollection,
  options: { disjoint?: boolean; bounds?: Bounds; toleranceM2?: number },
  mask: FeatureCollection | undefined,
  signal: AbortSignal,
  progress?: (s: string) => void,
) {
  const tick = checkpoint(signal, progress),
    toleranceM2 = options.toleranceM2 ?? 0.1;
  if (!Number.isFinite(toleranceM2) || toleranceM2 < 0)
    throw new Error("Invalid area tolerance");
  if (options.bounds) validBounds(options.bounds);
  if (
    source.features.some((f) => !polygon(f)) ||
    mask?.features.some((f) => !polygon(f))
  )
    throw new Error("Polygon checks require polygon results");
  const shapes = source.features as Surface[];
  const tree = new BoxTree(
    shapes.map((f, index) => ({ box: boundsOf(f), index })),
  );
  let maskUnion: Surface | null = null;
  if (mask?.features.length)
    maskUnion =
      mask.features.length === 1
        ? (mask.features[0] as Surface)
        : union(
            mask as FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
          );
  let overlapsM2 = 0,
    outsideBoundsM2 = 0,
    excludedOverlapM2 = 0,
    areaM2 = 0,
    invalid = 0;
  for (let i = 0; i < shapes.length; i++) {
    const f = shapes[i]!;
    areaM2 += area(f);
    if (!valid(f)) invalid++;
    if (options.disjoint)
      for (const j of tree.search(boundsOf(f)))
        if (j > i) {
          const v = intersect(fc([f, shapes[j]!]));
          if (v) overlapsM2 += area(v);
          await tick(`Checking overlap · ${i + 1}/${shapes.length} polygons`);
        }
    if (maskUnion) {
      const v = intersect(fc([f, maskUnion]));
      if (v) excludedOverlapM2 += area(v);
    }
    if (options.bounds) {
      const v = difference(fc([f, rect(options.bounds)]));
      if (v) outsideBoundsM2 += area(v);
    }
    await tick(`Checking geometry · ${i + 1}/${shapes.length} polygons`);
  }
  signal.throwIfAborted();
  return {
    passed:
      invalid === 0 &&
      overlapsM2 <= toleranceM2 &&
      outsideBoundsM2 <= toleranceM2 &&
      excludedOverlapM2 <= toleranceM2,
    polygonCount: shapes.length,
    areaM2,
    invalid,
    overlapsM2: options.disjoint ? overlapsM2 : null,
    outsideBoundsM2: options.bounds ? outsideBoundsM2 : null,
    excludedOverlapM2: mask ? excludedOverlapM2 : null,
    toleranceM2,
    empty: shapes.length === 0,
    notes: [
      "Checks apply only to supplied retained geometry. Area is summed over features; overlap is pairwise. Validity checks ring structure, not every possible topology defect. Unrequested checks are null.",
    ],
  };
}
