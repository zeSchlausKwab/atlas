import { objectSchema } from "../../operations/src/registry";
import { colorSchema } from "./drawing-style";
const ref = { type: "string", minLength: 1 };
const bounds = {
  type: "array",
  items: { type: "number" },
  minItems: 4,
  maxItems: 4,
};
export const recipeSpecs: Array<[string, string, Record<string, unknown>]> = [
  [
    "result_rows",
    "Inspect a page from ANY cached workspace or derived geometry result using the same normalized properties. Locations have Point geometry, source IDs are preserved. Geometry stays on the device; use map_draw. nextOffset supports paging.",
    objectSchema(
      {
        result: ref,
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        fields: { type: "array", items: ref },
      },
      ["result"],
    ),
  ],
  [
    "result_merge",
    "Merge cached results into one normalized geometry result, deduplicating identical source IDs across chunks. Conflicting copies fail explicitly. No reads; prefer a single combined workspace_prepare over manual west/east splits.",
    objectSchema({ results: { type: "array", items: ref, minItems: 1 } }, [
      "results",
    ]),
  ],
  [
    "result_style",
    "Style cached geometry without JavaScript. Numeric breaks: ascending thresholds with N+1 colors; intervals are lower-inclusive/upper-exclusive. Categories: explicit values/labels with one color each. Uniform: one color. Unknown/non-numeric values remain gray and are counted. Optional labelField binds text. Returns result/style/legend; map_draw inherits these automatically.",
    objectSchema(
      {
        result: ref,
        field: ref,
        breaks: { type: "array", minItems: 1, items: { type: "number" } },
        categories: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            { value: { type: ["string", "number", "boolean"] }, label: ref },
            ["value"],
          ),
        },
        colors: { type: "array", minItems: 1, items: colorSchema },
        labelField: ref,
        unit: ref,
        unknownColor: colorSchema,
      },
      ["result", "colors"],
    ),
  ],
  [
    "result_check",
    "Check polygon structure, summed area, optional pairwise disjointness, clipping bounds and explicit excluded polygon mask. Returns measurements and passed, with empty result explicit. Not a completeness or real-world truth check. Recipes stop before publishing if checks fail.",
    objectSchema(
      {
        result: ref,
        disjoint: { type: "boolean" },
        bounds,
        excludeResult: ref,
        toleranceM2: { type: "number", minimum: 0 },
      },
      ["result"],
    ),
  ],
  [
    "recipe_define",
    "Save a reusable native analysis on this device. Start from existing cached result references, preferably one combined workspace across compatible chunks. parameters are numeric controls {value,min,max,step,unit,label}; args use exact strings $param.NAME or $step.ID (the step result/field reference). Steps run in array order; output is a step ID. Allowed tools: result_filter/merge/style/check, spatial_* geometry operations, field_create/contours. No workspace loads, code or drawing side effects inside a recipe. For suitability: buffer individual parks/rails/stops then filter buildings (invert for exclusions); avoid dissolving large corridors just to filter. Include result_check after bands/exclusion/clipping, before styling. recipe_run publishes the output with adjustable controls; unchanged steps reuse cached results.",
    objectSchema(
      {
        title: ref,
        parameters: {
          type: "object",
          additionalProperties: objectSchema(
            {
              value: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              step: { type: "number", exclusiveMinimum: 0 },
              unit: ref,
              label: ref,
            },
            ["value", "min", "max"],
          ),
        },
        steps: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            { id: ref, tool: ref, args: { type: "object" } },
            ["id", "tool", "args"],
          ),
        },
        output: ref,
      },
      ["title", "parameters", "steps", "output"],
    ),
  ],
  [
    "recipe_run",
    "Run a saved analysis with optional parameter changes. Reuses unchanged native steps; no new map reads. Publishes/replaces its map layer only after all steps and checks succeed. Controls also let the user rerun without another model round.",
    objectSchema(
      {
        recipe: ref,
        parameters: {
          type: "object",
          additionalProperties: { type: "number" },
        },
      },
      ["recipe"],
    ),
  ],
];
