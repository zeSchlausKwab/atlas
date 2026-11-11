import { prepareWorldInput, usesWorldInput } from "./world-input";
import { prepareOcean } from "./ocean-source";
import { BUILD_DISK_FLOOR, DISK_RESERVE, BUILD_STOP_MARGIN } from "./capacity";
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildCheckpoints,
  cachedSourceDate,
  type VerifiedBuildSource,
} from "./cached-build";
import { compilePartitioned } from "../../cli/src/partitioned";
import { runCompiler } from "./process";
import type { PackageSelection, PreparationProgress } from "./selection";
import { compilerProgress } from "./compiler-progress";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export async function importPartitionedCached(
  source: VerifiedBuildSource,
  s: PackageSelection,
  work: string,
  bounds: [number, number, number, number],
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
  artifacts = work,
) {
  await mkdir(work, { recursive: true });
  await mkdir(artifacts, { recursive: true });
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
      join(artifacts, "extraction"),
      identity,
    ).open(),
    name = "area.osm.pbf",
    partial = join(cp.directory, name) + ".part.osm.pbf";
  let area = join(cp.directory, name);
  const filteredWorld = source.kind === "planet" && usesWorldInput(s);
  let completed = 0;
  let lastMeasured: Partial<PreparationProgress> | undefined;
  const progress = (
    message: string,
    phase: PreparationProgress["phase"] = "compiling",
  ) => {
    const measured = compilerProgress(message);
    if (measured && measured.stage === lastMeasured?.stage) {
      for (const key of [
        "checkpointAt",
        "stagingBytes",
        "indexBytes",
        "etaSeconds",
        "elapsedSeconds",
      ] as const)
        if (measured[key] === undefined && lastMeasured?.[key] !== undefined)
          (measured as any)[key] = lastMeasured[key];
    }
    lastMeasured = measured;
    report({
      phase,
      message,
      completed,
      total: 0,
      unit: "stages",
      readBytes: 0,
      writtenBytes: cp.savedBytes,
      ...measured,
    });
  };
  const abort = new AbortController();
  let failure: Error | undefined;
  const check = async () => {
    const disks = await Promise.all(
      [...new Set([work, artifacts])].map((p) => statfs(p)),
    );
    if (
      Math.min(...disks.map((fs) => fs.bavail * fs.bsize)) < BUILD_DISK_FLOOR
    ) {
      failure = new Error(
        `Preparation paused to preserve ${DISK_RESERVE / 1024 ** 3} GiB free plus a ${BUILD_STOP_MARGIN / 1024 ** 3} GiB stopping buffer. Free space and resume the saved stages.`,
      );
      abort.abort();
      throw failure;
    }
  };
  const timer = setInterval(() => void check().catch(() => {}), 2000);
  try {
    const ocean = await prepareOcean(
      s,
      join(artifacts, "ocean"),
      AbortSignal.any([signal, abort.signal]),
      progress,
    );
    progress("Verifying the saved extraction before reuse…", "verifying");
    const hashProgress = (done: number, total: number) =>
      report({
        phase: "verifying",
        message: "Verifying saved extraction checksum",
        completed: done,
        total,
        unit: "bytes",
        readBytes: done,
        writtenBytes: cp.savedBytes,
      });
    if (filteredWorld) {
      area = await prepareWorldInput(
        source,
        join(dirname(work), ".world-inputs"),
        AbortSignal.any([signal, abort.signal]),
        (line) => progress(line, "extracting"),
      );
    } else if (!(await cp.reusable(name, hashProgress, signal))) {
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
          s.featureKinds.includes("boundaries")
            ? "types=multipolygon,restriction,boundary"
            : "types=multipolygon,restriction",
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
      ocean,
      input: area,
      output: join(artifacts, "source.atlas"),
      artifacts: join(artifacts, "compiler"),
      work: join(work, "compiler"),
      selection: s,
      signal: AbortSignal.any([signal, abort.signal]),
      reserveBytes: BUILD_DISK_FLOOR,
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
          strategy: filteredWorld
            ? "world-families-v1; osmium tags-filter with referenced geometry; original OSM identities; display/labels clipped to supported world extent"
            : s.featureKinds.includes("boundaries")
              ? "smart; types=multipolygon,restriction,boundary; partitioned-build-v1"
              : "smart; types=multipolygon,restriction; partitioned-build-v1",
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
