import type { FeatureCollection } from "geojson";
import { project } from "../../format/src/index";
import {
  FEATURE_ZOOM,
  geometryBounds,
  type FeatureKind,
  type MapFeature,
} from "./index";
/** Full OSM shapes are replicated into intersecting grid cells; queries deduplicate by OSM identity. */
export function buildFeatures(source: FeatureCollection) {
  const cells = new Map<string, MapFeature[]>(),
    n = 2 ** FEATURE_ZOOM;
  for (const f of source.features) {
    if (
      !f.geometry ||
      !["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(
        f.geometry.type,
      )
    )
      continue;
    const p = f.properties ?? {},
      cls = Number(p.class);
    const kind: FeatureKind | undefined =
      cls === 2
        ? "buildings"
        : cls === 1
          ? "water"
          : cls === 6
            ? "railways"
            : [3, 4, 5].includes(cls)
              ? "roads"
              : cls === 0
                ? "land"
                : undefined;
    if (!kind) continue;
    const id = String(p.id);
    if (!/^(way|relation)\/\d+$/.test(id)) continue;
    const bbox = geometryBounds(f.geometry),
      a = project(bbox[0], bbox[3]),
      b = project(bbox[2], bbox[1]);
    const xmin = Math.max(0, Math.floor(a[0] * n)),
      xmax = Math.min(n - 1, Math.floor(b[0] * n)),
      ymin = Math.max(0, Math.floor(a[1] * n)),
      ymax = Math.min(n - 1, Math.floor(b[1] * n));
    if ((xmax - xmin + 1) * (ymax - ymin + 1) > 4096)
      throw new Error(
        `Feature ${id} spans too many cells for this regional prototype`,
      );
    const feature: MapFeature = {
      type: "Feature",
      id,
      bbox,
      geometry: f.geometry,
      properties: { id, name: String(p.name ?? ""), kind, tags: p.tags ?? {} },
    };
    for (let x = xmin; x <= xmax; x++)
      for (let y = ymin; y <= ymax; y++) {
        const k = `features/${kind}/${FEATURE_ZOOM}/${x}/${y}`;
        let c = cells.get(k);
        if (!c) {
          c = [];
          cells.set(k, c);
        }
        c.push(feature);
      }
  }
  return cells;
}
