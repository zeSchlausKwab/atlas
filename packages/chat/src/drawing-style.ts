import Ajv from "ajv";
import type { Feature, FeatureCollection } from "geojson";

/** Explicit property bindings: source tags never become executable style expressions. */
export interface DrawingStyle {
  colorProperty?: string | null;
  radiusProperty?: string | null;
  labelProperty?: string | null;
  pointRadius?: number;
  strokeWidth?: number;
  fillOpacity?: number;
  labelSize?: number;
  labelColor?: string;
  labelPlacement?: "above" | "center";
}
export interface LegendEntry {
  label: string;
  color: string;
}
export const colorSchema = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const property = { type: ["string", "null"], minLength: 1 };
export const drawingStyleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    colorProperty: {
      ...property,
      description:
        "Feature property containing a six-digit hex color. Missing/null uses the layer color. null removes the binding.",
    },
    radiusProperty: {
      ...property,
      description:
        "Feature property containing a positive marker radius in screen pixels. Missing/null uses pointRadius.",
    },
    labelProperty: {
      ...property,
      description:
        "Feature property containing text or a number to draw. Missing/null hides that feature's label.",
    },
    pointRadius: { type: "number", exclusiveMinimum: 0 },
    strokeWidth: { type: "number", minimum: 0 },
    fillOpacity: { type: "number", minimum: 0, maximum: 1 },
    labelSize: { type: "number", exclusiveMinimum: 0 },
    labelColor: colorSchema,
    labelPlacement: {
      enum: ["above", "center"],
      description:
        "center makes numbered point badges; above makes text annotations.",
    },
  },
};
export const legendSchema = {
  type: "array",
  description:
    "Explicit legend with category/range labels and units; use [] to clear it.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["label", "color"],
    properties: { label: { type: "string", minLength: 1 }, color: colorSchema },
  },
};
const ajv = new Ajv({ strict: false, ownProperties: true });
const valid = ajv.compile({
  type: "object",
  required: ["color", "style", "legend"],
  properties: {
    color: colorSchema,
    style: drawingStyleSchema,
    legend: legendSchema,
  },
});
function own(f: Feature, key?: string | null): unknown {
  return key && f.properties && Object.hasOwn(f.properties, key)
    ? f.properties[key]
    : undefined;
}
export function featureStyle(f: Feature, color: string, style: DrawingStyle) {
  const c = own(f, style.colorProperty) ?? color;
  if (typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c))
    throw new Error("Feature color must be a six-digit hex color");
  const radius = own(f, style.radiusProperty) ?? style.pointRadius ?? 5;
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0)
    throw new Error("Feature radius must be a positive number in pixels");
  const label = own(f, style.labelProperty);
  if (
    label != null &&
    typeof label !== "string" &&
    (typeof label !== "number" || !Number.isFinite(label))
  )
    throw new Error("Feature label must be text or a finite number");
  return { color: c, radius, label: label == null ? "" : String(label) };
}
export function validateLayerStyle(
  fc: FeatureCollection,
  color: string,
  style: DrawingStyle,
  legend: LegendEntry[],
) {
  if (!valid({ color, style, legend }))
    throw new Error("Invalid drawing style: " + ajv.errorsText(valid.errors));
  for (const value of Object.values(style))
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Style numbers must be finite");
  // Validate the whole batch before changing any visible state.
  for (const f of fc.features) featureStyle(f, color, style);
}

/** Choose ink/halo contrast from relative sRGB luminance. */
export function contrastingInk(color: string) {
  const linear = [1, 3, 5].map((i) => {
    const v = parseInt(color.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  return luminance > 0.179 ? "#142b25" : "#ffffff";
}
