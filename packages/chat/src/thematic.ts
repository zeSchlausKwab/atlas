import type { FeatureCollection } from "geojson";
import { property } from "../../spatial/src/index";
import type { DrawingStyle, LegendEntry } from "./drawing-style";
export interface ThemeInput {
  field?: string;
  breaks?: number[];
  categories?: Array<{ value: string | number | boolean; label?: string }>;
  colors: string[];
  labelField?: string;
  unit?: string;
  unknownColor?: string;
}
export function thematic(collection: FeatureCollection, input: ThemeInput) {
  const colors = input.colors,
    unknownColor = input.unknownColor ?? "#8a918b";
  if (
    !colors?.length ||
    [...colors, unknownColor].some((c) => !/^#[0-9a-f]{6}$/i.test(c))
  )
    throw new Error("Provide six-digit hex colors");
  if (input.breaks && input.categories)
    throw new Error("Choose numeric breaks or categories");
  if ((input.breaks || input.categories) && !input.field)
    throw new Error("A thematic field is required");
  if (
    input.breaks &&
    (input.breaks.some(
      (b, i) => !Number.isFinite(b) || (i > 0 && b <= input.breaks![i - 1]!),
    ) ||
      colors.length !== input.breaks.length + 1)
  )
    throw new Error("Breaks must increase; provide one more color than breaks");
  if (
    input.categories &&
    (colors.length !== input.categories.length ||
      new Set(input.categories.map((c) => JSON.stringify(c.value))).size !==
        input.categories.length)
  )
    throw new Error("Categories must be unique and have one color each");
  if (!input.breaks && !input.categories && colors.length !== 1)
    throw new Error("Uniform styling takes one color");
  const counts = colors.map(() => 0);
  let unknown = 0;
  const features = collection.features.map((f) => {
    const v = input.field ? property(f.properties, input.field) : undefined;
    let index = 0;
    if (input.categories)
      index = input.categories.findIndex((c) => c.value === v);
    else if (input.breaks)
      index =
        typeof v === "number" && Number.isFinite(v)
          ? input.breaks.filter((b) => v >= b).length
          : -1;
    if (index < 0) unknown++;
    else counts[index]!++;
    const label = input.labelField
      ? property(f.properties, input.labelField)
      : undefined;
    return {
      ...f,
      properties: {
        ...f.properties,
        atlasColor: index < 0 ? unknownColor : colors[index],
        atlasLabel:
          typeof label === "string" || typeof label === "number" ? label : null,
      },
    };
  });
  const unit = input.unit ? " " + input.unit : "";
  const legend: LegendEntry[] = colors.map((color, i) => {
    let label = input.field ?? "Selected features";
    if (input.categories)
      label = input.categories[i]!.label ?? String(input.categories[i]!.value);
    else if (input.breaks)
      label =
        i === 0
          ? `< ${input.breaks[0]}${unit}`
          : i === input.breaks.length
            ? `≥ ${input.breaks[i - 1]}${unit}`
            : `${input.breaks[i - 1]}–<${input.breaks[i]}${unit}`;
    return { color, label: `${label} (${counts[i]!.toLocaleString()})` };
  });
  if (unknown)
    legend.push({
      color: unknownColor,
      label: `Unknown / unclassified (${unknown.toLocaleString()})`,
    });
  const style: DrawingStyle = {
    colorProperty: "atlasColor",
    labelProperty: input.labelField ? "atlasLabel" : null,
    fillOpacity: 0.3,
    strokeWidth: 1,
  };
  return {
    collection: { type: "FeatureCollection", features } as FeatureCollection,
    style,
    legend,
    counts,
    unknown,
  };
}
