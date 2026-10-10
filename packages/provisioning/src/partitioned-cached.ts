import { mkdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildCheckpoints,
  cachedSourceDate,
  type VerifiedBuildSource,
} from "./cached-build";
import { compilePartitioned } from "../../cli/src/partitioned";
import { runCompiler } from "./process";
import { SOURCE_RESERVE } from "./source-cache";
import type { PackageSelection, PreparationProgress } from "./selection";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export async function importPartitionedCached(
  source: VerifiedBuildSource,
  s: PackageSelection,
  work: string,
  bounds: [number, number, number, number],
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  await mkdir(work, { recursive: true });
  const identity = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        version: 1,
        source: source.sha256,
        selection: s,
        bounds,
      }),
    )
    .digest("hex");
  const cp = await new BuildCheckpoints(
      join(work, "extraction"),
      identity,
    ).open(),
    name = "area.osm.pbf",
    area = join(cp.directory, name),
    partial = area + ".part.osm.pbf";
  let completed = 0;
  const progress = (
    message: string,
    phase: PreparationProgress["phase"] = "compiling",
  ) =>
    report({
      phase,
      message,
      completed,
      total: 0,
      unit: "stages",
      readBytes: 0,
      writtenBytes: cp.savedBytes,
    });
  const abort = new AbortController();
  let failure: Error | undefined;
  const check = async () => {
    const fs = await statfs(work);
    if (fs.bavail * fs.bsize < SOURCE_RESERVE + 2 * 1024 ** 3) {
      failure = new Error(
        "Preparation paused to preserve 60 GiB free. Free space and resume the saved stages.",
      );
      abort.abort();
      throw failure;
    }
  };
  const timer = setInterval(() => void check().catch(() => {}), 2000);
  try {
    if (!(await cp.reusable(name))) {
      await check();
      progress(
        "Extracting selected area from the verified local PBF (three passes)…",
        "extracting",
      );
      await runCompiler(
        [
          "osmium",
          "extract",
          source.path,
          `--bbox=${bounds.join(",")}`,
          "--strategy=smart",
          "-S",
          "types=multipolygon,restriction",
          "--set-bounds",
          "--overwrite",
          "--progress",
          "-o",
          partial,
        ],
        ROOT,
        AbortSignal.any([signal, abort.signal]),
        (line) => progress(line, "extracting"),
      );
      await runCompiler(
        ["osmium", "check-refs", partial],
        ROOT,
        signal,
        (line) => progress(line, "extracting"),
      );
      await rename(partial, area);
      await cp.complete(name);
    }
    progress("Verified regional PBF is ready; compiling bounded stages…");
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
      signal,
      (line) => progress(line),
    );
    return await compilePartitioned({
      input: area,
      output: join(work, "source.atlas"),
      work: join(work, "compiler"),
      selection: s,
      signal: AbortSignal.any([signal, abort.signal]),
      reserveBytes: SOURCE_RESERVE + 2 * 1024 ** 3,
      progress: (message) => {
        if (message.startsWith("Saved")) completed++;
        progress(message);
      },
      source: {
        url: source.url,
        sha256: source.sha256,
        attribution: "© OpenStreetMap contributors · ODbL",
        inputs: [
          { url: source.url, bytes: source.bytes, sha256: source.sha256 },
        ],
        extraction: {
          bounds,
          strategy:
            "smart; types=multipolygon,restriction; partitioned-build-v1",
          sourceDate: cachedSourceDate(source),
        },
      },
    });
  } catch (e) {
    throw failure ?? e;
  } finally {
    clearInterval(timer);
    await rm(partial, { force: true });
  }
}
