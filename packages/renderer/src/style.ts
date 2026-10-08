/** Portable paint only. Data subscriptions and camera state are separate contracts. */
export const PAINT_CLASSES = [
  "land",
  "water",
  "buildings",
  "roads",
  "majorRoads",
  "paths",
  "railways",
  "peaks",
] as const;
export type PaintClass = (typeof PAINT_CLASSES)[number];
export interface MapStyle {
  version: 1;
  name: string;
  background: string;
  colors: Record<PaintClass, string>;
  widths: { roads: number; paths: number; railways: number; water: number };
  labels: { color: string; halo: string; scale: number };
}
export const PAPER: MapStyle = {
  version: 1,
  name: "Paper",
  background: "#e8e6d6",
  colors: {
    land: "#b8c79e",
    water: "#78adba",
    buildings: "#baa88f",
    roads: "#f0e3c4",
    majorRoads: "#c97842",
    paths: "#ada378",
    railways: "#737d75",
    peaks: "#63664d",
  },
  widths: { roads: 1, paths: 1, railways: 1, water: 1 },
  labels: { color: "#485148", halo: "#f9f6eb", scale: 1 },
};
export const STYLE_PRESETS: Record<string, MapStyle> = {
  paper: PAPER,
  midnight: {
    ...PAPER,
    name: "Midnight",
    background: "#18272e",
    colors: {
      land: "#243f3a",
      water: "#294e65",
      buildings: "#657a80",
      roads: "#8a9c9d",
      majorRoads: "#e4b270",
      paths: "#566e65",
      railways: "#788897",
      peaks: "#c2d9ce",
    },
    labels: { color: "#d4e4df", halo: "#18272e", scale: 1 },
  },
  blueprint: {
    ...PAPER,
    name: "Blueprint",
    background: "#eaf2f5",
    colors: {
      land: "#d9e6e9",
      water: "#9dcbdc",
      buildings: "#527e95",
      roads: "#ffffff",
      majorRoads: "#2c627f",
      paths: "#9ab4bc",
      railways: "#6990a2",
      peaks: "#315870",
    },
    labels: { color: "#254f67", halo: "#f2f8fa", scale: 1 },
  },
};
function object(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  const o = value as Record<string, unknown>;
  if (
    Object.keys(o).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(o, k))
  )
    throw new Error(`${path} has missing or unknown fields`);
  return o;
}
function color(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v))
    throw new Error(`${field} must be a #rrggbb color`);
  return v.toLowerCase();
}
function number(v: unknown, min: number, max: number, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`${field} must be between ${min} and ${max}`);
  return v;
}
/** Validate untrusted JSON and return an owned copy; never execute style code. */
export function parseStyle(value: unknown): MapStyle {
  const o = object(
    value,
    ["version", "name", "background", "colors", "widths", "labels"],
    "Style",
  );
  if (o.version !== 1) throw new Error("Unsupported style version");
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 80)
    throw new Error("Style name must contain 1–80 characters");
  const c = object(o.colors, PAINT_CLASSES, "colors"),
    w = object(o.widths, ["roads", "paths", "railways", "water"], "widths"),
    l = object(o.labels, ["color", "halo", "scale"], "labels");
  return {
    version: 1,
    name: o.name,
    background: color(o.background, "background"),
    colors: Object.fromEntries(
      PAINT_CLASSES.map((k) => [k, color(c[k], `colors.${k}`)]),
    ) as MapStyle["colors"],
    widths: {
      roads: number(w.roads, 0.25, 4, "widths.roads"),
      paths: number(w.paths, 0.25, 4, "widths.paths"),
      railways: number(w.railways, 0.25, 4, "widths.railways"),
      water: number(w.water, 0.25, 4, "widths.water"),
    },
    labels: {
      color: color(l.color, "labels.color"),
      halo: color(l.halo, "labels.halo"),
      scale: number(l.scale, 0.75, 1.75, "labels.scale"),
    },
  };
}
export function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
export function compileStyle(input: MapStyle) {
  const style = parseStyle(input);
  return {
    style,
    background: new Float32Array(rgb(style.background)),
    colors: new Float32Array(
      PAINT_CLASSES.flatMap((k) => rgb(style.colors[k])),
    ),
    widths: new Float32Array([
      1,
      style.widths.water,
      1,
      style.widths.roads,
      style.widths.roads,
      style.widths.paths,
      style.widths.railways,
      1,
    ]),
  };
}
export interface MapScene {
  pitch: number;
  bearing: number;
  extrude: boolean;
  fallbackHeight: number;
  heightScale: number;
  shading: number;
}
export const FLAT_SCENE: MapScene = {
  pitch: 0,
  bearing: 0,
  extrude: false,
  fallbackHeight: 12,
  heightScale: 1,
  shading: 0.7,
};
export function parseScene(value: unknown): MapScene {
  // Upgrade the previous saved illustrative-height experiment.
  if (value && typeof value === "object" && "buildingHeight" in value) {
    const old = object(
      value,
      ["pitch", "bearing", "buildingHeight", "shading"],
      "Scene",
    );
    const fallbackHeight = number(old.buildingHeight, 0, 100, "buildingHeight");
    value = {
      pitch: old.pitch,
      bearing: old.bearing,
      shading: old.shading,
      extrude: fallbackHeight > 0,
      fallbackHeight: fallbackHeight || 12,
      heightScale: 1,
    };
  }
  const o = object(
    value,
    ["pitch", "bearing", "extrude", "fallbackHeight", "heightScale", "shading"],
    "Scene",
  );
  if (typeof o.extrude !== "boolean")
    throw new Error("extrude must be a boolean");
  return {
    pitch: number(o.pitch, 0, 65, "pitch"),
    bearing: number(o.bearing, -180, 180, "bearing"),
    extrude: o.extrude,
    fallbackHeight: number(o.fallbackHeight, 1, 100, "fallbackHeight"),
    heightScale: number(o.heightScale, 0.25, 3, "heightScale"),
    shading: number(o.shading, 0, 1, "shading"),
  };
}
