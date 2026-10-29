import { mkdir, stat, statfs, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash } from "../../cli/src/source";
import { compilePartitioned } from "../../cli/src/partitioned";
import { importBounds } from "./global-source";
import { runCompiler } from "./process";
import { DISK_RESERVE } from "./capacity";
import { compilerProgress } from "./compiler-progress";
import { familySelection, pinnedPbfMatches } from "./families";
import type { VerifiedBuildSource } from "./cached-build";
import type { CapabilityChange } from "./compose-capabilities";
import type { Manifest } from "../../format/src/index";
import type { PreparationProgress } from "./selection";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Builds only the missing families. A routing-only request never enters semantic/display stages. */
export async function buildCapabilities(
  source: VerifiedBuildSource,
  target: Manifest,
  change: CapabilityChange,
  families: string[],
  work: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  if (!pinnedPbfMatches(target, source.sha256))
    throw new Error("PBF does not match this map's pinned source snapshot");
  await mkdir(work, { recursive: true });
  const abort = new AbortController(),
    combined = AbortSignal.any([signal, abort.signal]);
  let failure: Error | undefined;
  const check = async () => {
    const fs = await statfs(work);
    if (fs.bavail * fs.bsize < DISK_RESERVE) {
      failure = new Error(
        "Build stopped at the free-space reserve; original archives and source are retained",
      );
      abort.abort();
      throw failure;
    }
  };
  const timer = setInterval(() => void check().catch(() => {}), 2000);
  const progress = (
    message: string,
    phase: PreparationProgress["phase"] = "compiling",
  ) =>
    report({
      phase,
      message,
      completed: 0,
      total: 0,
      readBytes: 0,
      writtenBytes: 0,
      ...compilerProgress(message),
    });
  try {
    await check();
    const before = await stat(source.path);
    if (before.size !== source.bytes || before.mtimeMs !== source.mtimeMs)
      throw new Error("PBF changed since planning");
    const hash = await fileHash(
      source.path,
      (completed, total) =>
        report({
          phase: "verifying",
          message: "Verifying retained source PBF",
          completed,
          total,
          unit: "bytes",
          readBytes: completed,
          writtenBytes: 0,
        }),
      combined,
    );
    if (hash !== source.sha256)
      throw new Error("Retained PBF checksum mismatch");
    const selection = familySelection(
      target,
      families,
      change.name,
      change.maxBytes,
      change.paddingCells,
    );
    const bounds = importBounds({ ...selection, maxSourceBytes: source.bytes });
    const input = join(work, "area.osm.pbf"),
      extraction = join(work, "extraction.json");
    const identity = JSON.stringify([
      hash,
      bounds,
      selection.featureKinds.includes("boundaries"),
    ]);
    let reusable = false;
    if (await Bun.file(extraction).exists()) {
      const receipt = await Bun.file(extraction).json();
      if (receipt.identity === identity && (await Bun.file(input).exists()))
        reusable =
          (await fileHash(input, undefined, combined)) === receipt.sha256;
    }
    if (!reusable) {
      progress("Extracting amendment area from retained PBF…", "extracting");
      await runCompiler(
        [
          "osmium",
          "extract",
          source.path,
          `--bbox=${bounds.join(",")}`,
          "--strategy=smart",
          "-S",
          selection.featureKinds.includes("boundaries")
            ? "types=multipolygon,restriction,boundary"
            : "types=multipolygon,restriction",
          "--set-bounds",
          "--overwrite",
          "--progress",
          "-o",
          input,
        ],
        ROOT,
        combined,
        (line) => progress(line, "extracting"),
      );
      await runCompiler(["osmium", "check-refs", input], ROOT, combined);
      await Bun.write(
        extraction + ".tmp",
        JSON.stringify({
          identity,
          sha256: await fileHash(input, undefined, combined),
        }),
      );
      await rename(extraction + ".tmp", extraction);
    }
    const after = await stat(source.path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("PBF changed during extraction");
    await runCompiler(
      [
        "cargo",
        "build",
        "--release",
        "--locked",
        "-p",
        "atlas-osm-import",
        "--bins",
      ],
      ROOT,
      combined,
      (line) => progress(line),
    );
    // No labels, source store, display tiles or feature indexes are built unless requested.
    return await compilePartitioned({
      input,
      output: join(work, "addition.atlas"),
      work: join(work, "compiler"),
      selection,
      signal: combined,
      reserveBytes: DISK_RESERVE,
      progress: (line) => progress(line),
      source: {
        ...target.source,
        sha256: source.sha256,
        inputs: [
          { url: source.url, sha256: source.sha256, bytes: source.bytes },
        ],
        extraction: {
          bounds,
          strategy: "smart; capability-amendment-v1",
          sourceDate:
            target.source.extraction?.sourceDate ??
            new Date(source.lastModified).toISOString().slice(0, 10),
        },
      },
    });
  } catch (e) {
    throw failure ?? e;
  } finally {
    clearInterval(timer);
  }
}
