import area from "@turf/area";
import booleanIntersects from "@turf/boolean-intersects";
import type { Polygon as GeoPolygon } from "geojson";
import type { Plugin } from "../packages/operations/src/registry";
import { objectSchema, polygonSchema, featureResultSchema } from "../packages/operations/src/registry";
import { validatePolygon, bounds, type Polygon } from "../packages/offline/src/geometry";
import { validateFeatureQuery, type MapFeature, type FeatureResult } from "../packages/features/src/index";
export interface LakeInput { polygon: Polygon; limit?: number }
export interface LakeResult extends FeatureResult {
  analysis: { measurement: string; classification: string; scanned: number; unclassifiedWater: number; coverage: string; region: Polygon };
}
const plugin: Plugin<LakeInput, LakeResult> = {
  descriptor: {
    id: "atlas.lakes.rank", version: "1.0.0", title: "Largest lakes", description: "Rank retained water=lake polygons intersecting an area by their whole polygon area. Holes are subtracted; rivers and reservoirs are excluded. Source coverage may be incomplete.",
    inputSchema: objectSchema({ polygon: { ...polygonSchema, title: "Area", "x-atlas-widget": "polygon" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10, title: "Number of lakes" } }, ["polygon"]),
    outputSchema: { ...featureResultSchema, required: [...featureResultSchema.required, "analysis"], properties: { ...featureResultSchema.properties, analysis: { type: "object", required: ["measurement", "classification", "scanned", "unclassifiedWater", "coverage", "region"] } } },
    requirements: [{ capability: "feature-extraction", family: "features/water", schema: "features-v1" }], purposes: ["features"], result: "geojson", execution: ["device", "server"], federation: "single-executor", limits: { maxSpanDegrees: 0.25, maxScanBytes: 67108864, maxObjects: 100000 },
  },
  validate(i) { validatePolygon(i.polygon); validateFeatureQuery({ kind: "water", bounds: bounds(i.polygon) }); },
  async run(input, c) {
    const region: GeoPolygon = { type: "Polygon", coordinates: [[...input.polygon, input.polygon[0]!]] };
    let scanned = 0, unclassifiedWater = 0, matched = 0;
    const top: { feature: MapFeature; area: number }[] = [], limit = input.limit ?? 10;
    for await (const f of c.data.scanFeatures({ kind: "water", bounds: bounds(input.polygon) })) {
      c.signal.throwIfAborted();
      if (++scanned % 500 === 0) c.progress(`Examined ${scanned.toLocaleString()} water objects`);
      if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
      if (!booleanIntersects(f.geometry, region)) continue;
      if (!f.properties.tags.water) { unclassifiedWater++; continue; }
      if (f.properties.tags.water !== "lake") continue;
      matched++;
      top.push({ feature: f, area: area(f) });
      top.sort((a, b) => b.area - a.area || a.feature.id.localeCompare(b.feature.id));
      if (top.length > limit) top.pop();
    }
    return {
      type: "FeatureCollection", features: top.map(({ feature: f, area }, i) => ({ ...f, properties: { ...f.properties, tags: { ...f.properties.tags, "atlas:rank": String(i + 1), "atlas:area_m2": area.toFixed(2), "atlas:measurement": "whole retained polygon; holes subtracted" } } })),
      matched, truncated: matched > limit, snapshot: c.manifest.snapshot, attribution: c.manifest.source.attribution,
      analysis: { measurement: "Spherical area in square metres of whole retained geometry, not clipped to the selection.", classification: "OSM water=lake only", scanned, unclassifiedWater, coverage: "Source extract only; missing classification and source-boundary truncation can make this ranking incomplete.", region: input.polygon },
    };
  },
};
export default plugin;
