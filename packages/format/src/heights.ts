/** Heights are above local ground, not elevation above sea level. */
export interface BuildingHeight {
  height: number;
  minHeight: number;
  source: number;
}
export const MAX_BUILDING_HEIGHT = 2000;
// source bits 0–1: top (0 missing, 1 height, 2 levels); bits 2–3: base (0 ground, 1 min_height, 2 min_level).
export function meters(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  const decimal = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(m|ft|feet)?$/i);
  const feet = text.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  const height = decimal
    ? Number(decimal[1]) * (/^(ft|feet)$/i.test(decimal[2] ?? "") ? 0.3048 : 1)
    : feet
      ? Number(feet[1]) * 0.3048 + Number(feet[2] ?? 0) * 0.0254
      : NaN;
  return Number.isFinite(height) && height >= 0 && height <= MAX_BUILDING_HEIGHT
    ? height
    : undefined;
}
function levels(value: unknown) {
  return typeof value === "string" &&
    /^\d+(?:\.\d+)?$/.test(value.trim()) &&
    Number(value) <= 500
    ? Number(value)
    : undefined;
}
export function buildingHeight(
  tags: Record<string, unknown> = {},
): BuildingHeight {
  const explicit = meters(tags.height),
    floors = levels(tags["building:levels"]);
  const roof =
    meters(tags["roof:height"]) ?? (levels(tags["roof:levels"]) ?? 0) * 3;
  let height = explicit ?? (floors === undefined ? -1 : floors * 3 + roof),
    source = explicit !== undefined ? 1 : floors === undefined ? 0 : 2;
  if (height > MAX_BUILDING_HEIGHT || height === 0) {
    height = -1;
    source = 0;
  }
  const base = meters(tags.min_height),
    baseLevels = levels(tags["building:min_level"]);
  let minHeight = base ?? (baseLevels ?? 0) * 3;
  let baseSource = base !== undefined ? 1 : baseLevels === undefined ? 0 : 2;
  height = Math.fround(height);
  minHeight = Math.fround(minHeight);
  if ((height >= 0 && minHeight >= height) || minHeight > MAX_BUILDING_HEIGHT) {
    minHeight = 0;
    baseSource = 0;
  }
  return { height, minHeight, source: source | (baseSource << 2) };
}
export function validBuildingHeight(h: BuildingHeight): boolean {
  return (
    Number.isFinite(h.height) &&
    Number.isFinite(h.minHeight) &&
    (h.height === -1 || (h.height > 0 && h.height <= MAX_BUILDING_HEIGHT)) &&
    h.minHeight >= 0 &&
    h.minHeight <= MAX_BUILDING_HEIGHT &&
    (h.height === -1 || h.minHeight < h.height) &&
    Number.isInteger(h.source) &&
    h.source >= 0 &&
    h.source <= 10 &&
    (h.source & 3) <= 2 &&
    ((h.source >> 2) & 3) <= 2 &&
    ((h.source & 3) === 0) === (h.height === -1)
  );
}
