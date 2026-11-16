import type { PackageSelection } from "./selection";
import { bounds } from "../../offline/src/geometry";
import { project } from "../../format/src/index";
const MIB = 1024 ** 2,
  GIB = 1024 ** 3;
export type ByteRange = { low: number; high: number };
export interface EstimateSource {
  kind: "planet" | "regional" | "atlas";
  bytes: number;
  bounds?: [number, number, number, number];
  download?: boolean;
}
export interface PreparationEstimate {
  output: ByteRange;
  temporary: ByteRange;
  downloadBytes: number;
  sourceReadBytes: number;
  components: { name: string; bytes: ByteRange }[];
  candidateTiles: number;
  notes: string[];
}
const range = (low: number, high: number): ByteRange => ({
  low: Math.ceil(low),
  high: Math.ceil(high),
});
const multiply = (a: ByteRange, low: number, high = low) =>
  range(a.low * low, a.high * high);
const sum = (a: ByteRange[]) =>
  range(
    a.reduce((n, r) => n + r.low, 0),
    a.reduce((n, r) => n + r.high, 0),
  );
function sphericalBox(b: [number, number, number, number]) {
  return (
    (b[2] - b[0]) *
    (Math.sin((b[3] * Math.PI) / 180) - Math.sin((b[1] * Math.PI) / 180))
  );
}
/** Number of candidate tile cells, not a prediction of populated tiles. */
export function candidateTileCount(
  s: Pick<PackageSelection, "polygon" | "minZoom" | "maxZoom">,
) {
  const b = bounds(s.polygon),
    nw = project(b[0], b[3]),
    se = project(b[2], b[1]);
  let count = 0;
  for (let z = s.minZoom; z <= s.maxZoom; z++) {
    const n = 2 ** z;
    count +=
      Math.max(
        0,
        Math.min(n - 1, Math.floor(se[0] * n)) -
          Math.max(0, Math.floor(nw[0] * n)) +
          1,
      ) *
      Math.max(
        0,
        Math.min(n - 1, Math.floor(se[1] * n)) -
          Math.max(0, Math.floor(nw[1] * n)) +
          1,
      );
  }
  return count;
}
/** Uncalibrated planning model v1, not a measured size or an admission guarantee.
 * Ratios deliberately span compression, density and repeated tile geometry.
 * Never use NO_SIZE_LIMIT as data. Zoom affects display tiles, not exact features.
 * Keep coefficients and assumptions here so the host and admission agree.
 */
export function estimatePreparation(
  s: PackageSelection,
  source: EstimateSource,
): PreparationEstimate {
  const b = bounds(s.polygon),
    world = [-180, -85, 180, 85] as [number, number, number, number];
  const coverage = source.kind === "planet" ? world : source.bounds;
  const fraction = coverage
    ? Math.min(1, sphericalBox(b) / sphericalBox(coverage))
    : undefined;
  // Geographic area alone cannot predict OSM density. Small city extracts can be
  // much denser than the source; absent coverage metadata, use the entire source.
  const crop =
    fraction === undefined
      ? range(source.bytes * 0.05, source.bytes)
      : fraction >= 0.999
        ? range(source.bytes, source.bytes)
        : range(
            source.bytes * fraction * 0.25,
            source.bytes * Math.min(1, fraction * 16),
          );
  const notes = [
    "Uncalibrated planning range, not a measured final size. Actual data density and compression can fall outside it; no build time is promised.",
    "Temporary space includes the cropped PBF, compiler databases and checkpoints. A small final file can still require a large build workspace.",
  ];
  if (fraction === undefined)
    notes.push(
      "This PBF has no coverage bounds in the source library. The range uses 5–100% of the source; it cannot reliably predict a tiny crop.",
    );
  else if (fraction < 0.999)
    notes.push(
      "Area-based extrapolation with a wide density allowance. Empty ocean and dense cities do not have equal data density; polygon envelopes include unselected space.",
    );
  const candidateTiles = s.layers.length ? candidateTileCount(s) : 0;
  if (source.kind === "atlas") {
    // Do not claim per-capability precision when only the archive size is known.
    notes.splice(
      0,
      notes.length,
      "Existing Atlas source: this allowance uses the entire archive, not selected blocks. It can substantially overestimate a small excerpt; rewritten indexes can also expand. Temporary space allows for spool files.",
    );
    return {
      output: range(0, 64 * MIB + source.bytes * 2),
      temporary: range(64 * MIB, Math.max(64 * MIB, source.bytes)),
      downloadBytes: 0,
      sourceReadBytes: source.bytes,
      components: [],
      candidateTiles,
      notes,
    };
  }
  const components: PreparationEstimate["components"] = [];
  const add = (name: string, low: number, high: number) =>
    components.push({ name, bytes: multiply(crop, low, high) });
  // Relative sum of display detail levels, normalized to z0–16.
  const zoomWeight = (lo: number, hi: number) => {
    let weight = 0;
    for (let z = lo; z <= hi; z++) weight += 2 ** ((z - 16) * 0.7);
    return weight;
  };
  const zoom = zoomWeight(s.minZoom, s.maxZoom) / zoomWeight(0, 16);
  const layers = {
    land: [0.15, 1.5],
    water: [0.08, 0.8],
    roads: [0.4, 3.2],
    railways: [0.01, 0.2],
    buildings: [0.6, 6],
    peaks: [0.002, 0.03],
  } as const;
  for (const layer of s.layers)
    add(
      `${layer} display tiles`,
      layers[layer][0] * zoom,
      layers[layer][1] * zoom,
    );
  if (s.ocean && s.layers.includes("water")) {
    // Even empty-ocean tiles occupy space. At planet z16 this can dominate.
    components.push({
      name: "Sea fill tiles & directory entries",
      bytes: range(candidateTiles * 40, candidateTiles * 600),
    });
    notes.push(
      "Sea fill is a separate coastline source. Its input and clipping overhead are not included in the PBF estimate; filled ocean tile counts grow rapidly with zoom.",
    );
  }
  if (s.placeNames) add("Place labels", 0.001, 0.02);
  if (s.streetNames) add("Street labels", 0.03, 0.3);
  if (s.pois) add("POI labels", 0.02, 0.25);
  for (const mode of s.profiles) add(`${mode} routing & isochrones`, 0.5, 3);
  if (s.search) add("Location & address search", 0.15, 1.5);
  if (s.reverse) add("Nearest-street index", 0.05, 0.5);
  if (s.peaks) add("Peak queries", 0.001, 0.02);
  for (const kind of s.featureKinds) {
    if (kind === "boundaries") {
      const max = s.boundaryMaxAdminLevel ?? 12;
      const factor =
        max <= 2
          ? 0.06
          : max <= 4
            ? 0.15
            : max <= 6
              ? 0.4
              : max <= 8
                ? 0.75
                : 1;
      add(
        `Administrative polygons · ${s.boundaryMaxAdminLevel ? `levels 1–${max}` : "all levels"}`,
        0.01 * factor,
        0.2 * factor,
      );
      notes.push(
        "Administrative geometry is retained at source detail. Lower display zoom does not shrink these polygons. Missing OSM boundaries are not synthesized.",
      );
    } else if (kind === "objects")
      add("Full tagged object archive & relationships", 1.5, 10);
    else
      add(
        `${kind} extractable features`,
        layers[kind][0],
        layers[kind][1] * 1.5,
      );
  }
  const data = sum(components.map((c) => c.bytes));
  const output = range(64 * 1024 + data.low * 1.05, MIB + data.high * 1.2);
  // The source importer still reads and indexes geometry even for a lean recipe.
  const expansion = s.featureKinds.includes("objects")
    ? 18
    : s.profiles.length
      ? 14
      : 10;
  const temporary = range(
    256 * MIB + crop.low * 2 + output.low,
    GIB + crop.high * expansion + output.high,
  );
  return {
    output,
    temporary,
    downloadBytes: source.download ? source.bytes : 0,
    sourceReadBytes: source.bytes,
    components,
    candidateTiles,
    notes,
  };
}
