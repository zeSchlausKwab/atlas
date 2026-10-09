import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../format/src/index";
import { downloadPbf } from "./download";
import { runCompiler } from "./process";
import type { PbfPlan } from "./global-source";
import type { PackageSelection, PreparationProgress } from "./selection";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Reject an impractical tile enumeration before downloading a source. */
export function validateImportSize(plan: PbfPlan, selection: PackageSelection) {
  if (!selection.layers.length) return;
  const nw = project(plan.bounds[0], plan.bounds[3]),
    se = project(plan.bounds[2], plan.bounds[1]);
  let tiles = 0;
  for (let z = selection.minZoom; z <= selection.maxZoom; z++) {
    const n = 2 ** z;
    tiles +=
      (Math.min(n - 1, Math.floor(se[0] * n)) -
        Math.max(0, Math.floor(nw[0] * n)) +
        1) *
      (Math.min(n - 1, Math.floor(se[1] * n)) -
        Math.max(0, Math.floor(nw[1] * n)) +
        1);
  }
  if (tiles > 500000)
    throw new Error(
      "This prototype supports up to 500,000 candidate tiles. Choose a smaller area or a lower maximum zoom before downloading.",
    );
}
export async function importPbf(
  plan: PbfPlan,
  selection: PackageSelection,
  cache: string,
  work: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  validateImportSize(plan, selection);
  await mkdir(work, { recursive: true });
  const downloaded = await downloadPbf(
    plan,
    cache,
    signal,
    (completed, cached) =>
      report({
        phase: "downloading",
        unit: "bytes",
        message: `${cached ? "Reusing verified" : "Downloading"} ${plan.region.name} PBF…`,
        completed,
        total: plan.bytes,
        readBytes: completed,
        writtenBytes: 0,
      }),
  );
  const stage = (phase: "extracting" | "compiling", message: string) =>
    report({
      phase,
      message,
      completed: 0,
      total: 0,
      readBytes: plan.bytes,
      writtenBytes: 0,
    });
  const input = join(work, "area.osm.pbf"),
    output = join(work, "source.atlas");
  stage(
    "extracting",
    "Cropping OSM data and completing ways, multipolygons and turn restrictions…",
  );
  await runCompiler(
    [
      "osmium",
      "extract",
      downloaded.path,
      `--bbox=${plan.bounds.join(",")}`,
      "--strategy=smart",
      "-S",
      "types=multipolygon,restriction",
      "--set-bounds",
      "--overwrite",
      "-o",
      input,
    ],
    ROOT,
    signal,
  );
  await runCompiler(["osmium", "check-refs", input], ROOT, signal);
  const date = plan.region.url.match(/-(\d{2})(\d{2})(\d{2})\.osm\.pbf$/);
  await Bun.write(
    input + ".source.json",
    JSON.stringify({
      url: plan.region.url,
      inputs: [
        {
          url: downloaded.receipt.url,
          bytes: downloaded.receipt.bytes,
          sha256: downloaded.receipt.sha256,
        },
      ],
      extraction: {
        bounds: plan.bounds,
        strategy: "smart; types=multipolygon,restriction",
        sourceDate: date
          ? `20${date[1]}-${date[2]}-${date[3]}`
          : new Date(plan.lastModified).toISOString().slice(0, 10),
      },
    }),
  );
  const recipe = join(work, "selection.json");
  await Bun.write(recipe, JSON.stringify(selection));
  stage("compiling", "Compiling selected map data and indexes…");
  await runCompiler(
    [
      process.execPath,
      join(ROOT, "packages/cli/src/index.ts"),
      "generate",
      "--input",
      input,
      "--output",
      output,
      "--name",
      selection.name,
      "--min-zoom",
      String(selection.minZoom),
      "--max-zoom",
      String(selection.maxZoom),
      "--bounds",
      plan.bounds.join(","),
      "--selection",
      recipe,
      "--max-bytes",
      String(Math.max(selection.maxBytes * 2, 64 * 1048576)),
      "--no-source-features",
      ...(selection.featureKinds.length ? ["--features"] : []),
    ],
    ROOT,
    signal,
    (line) => stage("compiling", line),
    { ...process.env, TMPDIR: work },
  );
  signal.throwIfAborted();
  return output;
}
