import { objectSchema } from "../../operations/src/registry";
const ref = { type: "string", minLength: 1 };
const positive = { type: "number", exclusiveMinimum: 0 };
const bounds = {
  type: "array",
  items: { type: "number" },
  minItems: 4,
  maxItems: 4,
};
const position = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
};
export const constructionSpecs: Array<
  [string, string, Record<string, unknown>]
> = [
  [
    "spatial_bands",
    "Construct dissolved, non-overlapping proximity polygons around cached points, lines or areas, with holes preserved. distancesMeters is strictly increasing, e.g. [100,250,500]. excludeSource defaults true: water/building interiors are removed. excludeResult optionally removes a separate polygon mask, e.g. ALL retained water rather than only the selected river. Optional bounds clip AFTER buffering. Returns bandIndex/fromMeters/toMeters/label/areaM2 for map_draw styling. Prefer this to grid squares or handwritten buffer code. Polygon distances start at banks/footprints; lines start at centerlines. Prepare padded source bounds first. This is NOT flood hazard modeling.",
    objectSchema(
      {
        result: ref,
        distancesMeters: { type: "array", items: positive, minItems: 1 },
        excludeSource: { type: "boolean" },
        excludeResult: ref,
        bounds,
        toleranceMeters: positive,
      },
      ["result", "distancesMeters"],
    ),
  ],
  [
    "spatial_shape",
    "Construct a cached circle (resolved center + radiusMeters), rectangle (bounds), polygon (rings: outer then holes), or corridor (cached line result + radiusMeters HALF-width). Polygon rings are closed automatically and checked for crossings/holes. Coordinates are [longitude,latitude]; ground them in search/source data or user input. Authored shapes are not observed boundaries. Returns a geometry result for map_draw/overlay/filter; no source reads.",
    objectSchema(
      {
        kind: { enum: ["circle", "rectangle", "polygon", "corridor"] },
        center: position,
        radiusMeters: positive,
        bounds,
        rings: {
          type: "array",
          minItems: 1,
          items: { type: "array", minItems: 3, items: position },
        },
        result: ref,
        toleranceMeters: positive,
      },
      ["kind"],
    ),
  ],
  [
    "field_create",
    "Cache a continuous numeric field sampled within bounds at cellMeters spacing. kind:distance computes metres to cached geometry (polygon interiors zero, holes outside); kind:density computes Gaussian density of Point/MultiPoint sources, requires bandwidthMeters, optional numeric weightField/weightUnit. Use spatial_points explicitly for representative locations. Prepare padded source bounds. Empty inputs yield unknown, not zero. Returns a field reference, range, units, resolution and provenance, NOT geometry. Use field_contours next. Choose ~25–50m for neighborhood distance contours, refine explicitly; narrow features may be undersampled. Local planar metric; not flood risk, terrain or travel time.",
    objectSchema(
      {
        result: ref,
        kind: { enum: ["distance", "density"] },
        bounds,
        cellMeters: positive,
        bandwidthMeters: positive,
        weightField: ref,
        weightUnit: ref,
      },
      ["result", "kind", "bounds", "cellMeters"],
    ),
  ],
  [
    "field_contours",
    "Trace smooth interpolated lines or filled bands from an existing field reference. thresholds are strictly increasing and use the field's units. mode:bands (default) uses adjacent endpoints, e.g. [0,100,250,500]; values outside them omitted. mode:lines traces each level. Returns a cached geometry result with lower/upper or value, label, unit, bandIndex and provenance for map_draw. Change thresholds freely: samples are reused with no map reads or field recomputation. For exact proximity bands around geometry prefer spatial_bands.",
    objectSchema(
      {
        field: ref,
        thresholds: { type: "array", items: { type: "number" }, minItems: 1 },
        mode: { enum: ["bands", "lines"] },
      },
      ["field", "thresholds"],
    ),
  ],
  [
    "field_inspect",
    "Inspect a cached field's units, value range, resolution, memory use, source coverage/provenance and assumptions. Sample arrays stay on the device.",
    objectSchema({ field: ref }, ["field"]),
  ],
  [
    "field_release",
    "Release a cached field's sample memory. Already-created contour results and drawings remain available. New chat also releases all fields.",
    objectSchema({ field: ref }, ["field"]),
  ],
];
