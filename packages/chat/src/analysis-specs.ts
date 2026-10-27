import { objectSchema } from "../../operations/src/registry";
import { recipeSpecs } from "./recipe-specs";
import { constructionSpecs } from "./construction-specs";
const ref = { type: "string", minLength: 1 };
const field = {
  type: "string",
  minLength: 1,
  description:
    "Property name, or dotted path such as tags.highway or address.street. geometryType is available for filtering points, lines and polygons. Derived numeric metrics are numbers; OSM tags remain strings.",
};
const bounds = {
  type: "array",
  items: { type: "number" },
  minItems: 4,
  maxItems: 4,
};
const positive = { type: "number", exclusiveMinimum: 0 };
export const conditionSchema = objectSchema(
  {
    field,
    op: { enum: ["eq", "exists", "gt", "gte", "lt", "lte", "contains"] },
    value: { type: ["string", "number", "boolean"] },
  },
  ["field", "op", "value"],
);
export const analysisSpecs: Array<[string, string, Record<string, unknown>]> = [
  ...constructionSpecs,
  ...recipeSpecs,
  [
    "spatial_measure",
    "Add areaM2 for polygons, lengthM for roads/rails/water lines, perimeterM for polygon outer and hole boundaries. Spherical units; non-applicable values null. Returns a cached result with original attributes. Use result_summary, result_filter, chart_show or map_draw next.",
    objectSchema({ result: ref }, ["result"]),
  ],
  [
    "spatial_points",
    "Convert each geometry to one representative surface point (default, on/inside the feature), or a vertex-mean centroid that may fall outside polygons. Preserves attributes/IDs. Useful for labels, proportional markers and proximity; these are not entrances.",
    objectSchema({ result: ref, mode: { enum: ["surface", "centroid"] } }, [
      "result",
    ]),
  ],
  [
    "spatial_buffer",
    "Buffer points, lines or polygons by distanceMeters. Useful for river/rail/road corridors or POI catchments by straight-line distance. Returns one polygon per source, preserving attributes; overlaps remain until spatial_overlay union. Approximate geographic buffers, not walking areas.",
    objectSchema({ result: ref, distanceMeters: positive }, [
      "result",
      "distanceMeters",
    ]),
  ],
  [
    "spatial_overlay",
    "Union, intersection or difference of polygon sets, dissolving each side first. Preserves holes. Use union with only result to dissolve overlapping buffers. For filtering points/lines use spatial_filter; rectangle clipping uses spatial_clip. Combined properties describe operation/area; input provenance is retained.",
    objectSchema(
      {
        result: ref,
        other: ref,
        mode: { enum: ["union", "intersection", "difference"] },
      },
      ["result", "mode"],
    ),
  ],
  [
    "spatial_clip",
    "Clip point, line and polygon geometry to a rectangle. Use before measurement for lengths/areas within a study boundary; preserves source attributes.",
    objectSchema({ result: ref, bounds }, ["result", "bounds"]),
  ],
  [
    "spatial_hull",
    "Create one convex hull around cached geometry. This can include large gaps; it is not a coverage boundary or reachable area. Collinear or insufficient points return an empty result.",
    objectSchema({ result: ref }, ["result"]),
  ],
  [
    "spatial_nearest",
    "For each source representative point find the nearest retained target geometry within maxDistanceMeters. Works for POIs, roads, rails, water and polygons. Adds distanceM, nearestId/name/point, matched. Null means no match within radius, not real-world absence. Straight-line distance, not routing or minimum footprint separation. mode:connectors draws links (unmatched retain source geometry).",
    objectSchema(
      {
        result: ref,
        other: ref,
        maxDistanceMeters: positive,
        excludeSameId: { type: "boolean" },
        mode: { enum: ["source", "connectors"] },
      },
      ["result", "other", "maxDistanceMeters"],
    ),
  ],
  [
    "spatial_filter",
    "Retain source geometries that intersect any target geometry (including touching), or whose representative point is within/on a target polygon. invert:true selects non-matches. Returns whole features; not clipping. For proximity, buffer the target first.",
    objectSchema(
      {
        result: ref,
        other: ref,
        mode: { enum: ["intersects", "representative_within"] },
        invert: { type: "boolean" },
        excludeSameId: { type: "boolean" },
      },
      ["result", "other"],
    ),
  ],
  [
    "spatial_join",
    "For each source geometry count intersecting target features: matchCount and matchIds. Optionally aggregate a numeric target field into sum/mean/min/max and knownCount/unknownCount. mode:representative_within tests each source representative point inside target polygons. Use polygons as source and POIs as target to count POIs per area. Overlapping sources can count a target multiple times.",
    objectSchema(
      {
        result: ref,
        other: ref,
        mode: { enum: ["intersects", "representative_within"] },
        field,
        excludeSameId: { type: "boolean" },
      },
      ["result", "other"],
    ),
  ],
  [
    "spatial_grid",
    "Aggregate cached features into an approximately cellMeters-sized geographic square grid within bounds. One representative surface point assigns each feature to one cell. Returns count, areaM2, densityPerKm2; optional numeric field adds sum/mean/min/max and knownCount/unknownCount. Empty cells retained. Does NOT measure clipped road length or polygon cover per cell. Count is retained features, not population.",
    objectSchema({ result: ref, bounds, cellMeters: positive, field }, [
      "result",
      "bounds",
      "cellMeters",
    ]),
  ],
  [
    "result_filter",
    "Filter/sort cached source or derived geometry results, including spatial metrics. AND conditions; unknown values fail numeric comparisons. Optionally keep a requested top N with limit; response reports total matches before that selection. ids matches exact source IDs. No new source reads.",
    objectSchema(
      {
        result: ref,
        where: { type: "array", items: conditionSchema },
        ids: { type: "array", items: ref },
        sort: objectSchema({ field, direction: { enum: ["asc", "desc"] } }, [
          "field",
        ]),
        limit: { type: "integer", minimum: 1 },
      },
      ["result"],
    ),
  ],
  [
    "result_summary",
    "Inspect any cached result: property names/types, geometry counts, and numeric statistics or category counts for an optional field. Unknowns reported separately; numeric strings are not silently converted. Includes provenance and units of derived operations. Use this instead of code for measurements and grouping.",
    objectSchema({ result: ref, field }, ["result"]),
  ],
  [
    "feature_inspect",
    "Read one cached feature's attributes, source identity, geometry type and provenance without returning raw geometry. Select exact id or zero-based index. For interactive inspection the user can also click Inspect drawings.",
    objectSchema(
      { result: ref, id: ref, index: { type: "integer", minimum: 0 } },
      ["result"],
    ),
  ],
];
export const chartSpecs: Array<[string, string, Record<string, unknown>]> = [
  [
    "chart_show",
    "Show a linked histogram, categorical bar chart, scatterplot or attribute table from a cached result. Charts are interactive on the device: selecting a bar, point, or table row highlights its source geometry. histogram/categories need field; scatter needs x and y. histogram bins default 12. Counts include all retained rows; missing/non-numeric values reported separately. Table columns are property paths. Use meaningful title and unit; this does not fetch source data.",
    objectSchema(
      {
        result: ref,
        title: { type: "string", minLength: 1 },
        kind: { enum: ["histogram", "categories", "scatter", "table"] },
        field,
        x: field,
        y: field,
        bins: { type: "integer", minimum: 1 },
        columns: { type: "array", items: field, minItems: 1 },
        unit: { type: "string" },
      },
      ["result", "title", "kind"],
    ),
  ],
  [
    "chart_remove",
    "Remove a chart from the analysis panel. Cached results stay available.",
    objectSchema({ chart: ref }, ["chart"]),
  ],
];
