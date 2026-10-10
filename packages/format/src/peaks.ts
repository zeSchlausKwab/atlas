import { project, type Peak } from "./index";
import type { AtlasReader } from "./reader";
import { bounds, inside, type Polygon } from "../../offline/src/geometry";
export function validPeak(p: Peak) {
  return (
    !!p &&
    typeof p.name === "string" &&
    Array.isArray(p.coordinates) &&
    p.coordinates.length === 2 &&
    p.coordinates.every(Number.isFinite) &&
    (p.elevation === null || Number.isFinite(p.elevation))
  );
}
export function peakSummary(value: unknown): {
  peak: Peak | null;
  known: number;
  unknown: number;
} {
  if (Array.isArray(value)) {
    if (!value.every(validPeak)) throw new Error("Invalid peak query block");
    const known = value
      .filter((p) => p.elevation !== null)
      .sort((a, b) => b.elevation - a.elevation);
    return {
      peak: known[0] ?? null,
      known: known.length,
      unknown: value.length - known.length,
    };
  }
  const s = value as {
    schema: string;
    peak: Peak | null;
    known: number;
    unknown: number;
  };
  if (
    !s ||
    s.schema !== "peaks-paged-v1" ||
    ![s.known, s.unknown].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    (s.known === 0
      ? s.peak !== null
      : !s.peak || !validPeak(s.peak) || s.peak.elevation === null)
  )
    throw new Error("Invalid peak summary");
  return { peak: s.peak, known: s.known, unknown: s.unknown };
}
export async function selectedPeaks(reader: AtlasReader, polygon: Polygon) {
  const root = JSON.parse(
    new TextDecoder().decode(await reader.block("query/peaks")),
  );
  if (Array.isArray(root)) {
    peakSummary(root);
    return (root as Peak[]).filter((p) => inside(p.coordinates, polygon));
  }
  peakSummary(root);
  const b = bounds(polygon),
    nw = project(b[0], b[3]),
    se = project(b[2], b[1]),
    n = 256,
    peaks: Peak[] = [];
  for (const block of await reader.spatial(
    "query/peaks-data",
    8,
    Math.floor(nw[0] * n),
    Math.min(n - 1, Math.floor(se[0] * n)),
    Math.floor(nw[1] * n),
    Math.min(n - 1, Math.floor(se[1] * n)),
  )) {
    const values = JSON.parse(
      new TextDecoder().decode(await reader.block(block.key)),
    ) as Peak[];
    peakSummary(values);
    peaks.push(...values.filter((p) => inside(p.coordinates, polygon)));
    reader.cache.delete(block.key);
    if (peaks.length > 1000000)
      throw new Error("Peak excerpt exceeds its record budget");
  }
  return peaks;
}
