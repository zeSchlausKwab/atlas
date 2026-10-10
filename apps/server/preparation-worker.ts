import {
  importCachedPbf,
  type VerifiedBuildSource,
} from "../../packages/provisioning/src/cached-build";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PackageSource } from "./package-source";
import { AtlasReader } from "../../packages/format/src/reader";
import { preparePackage } from "../../packages/provisioning/src/prepare";
import { importPbf } from "../../packages/provisioning/src/import-pbf";
import type { PbfPlan } from "../../packages/provisioning/src/global-source";
import type {
  PackageSelection,
  PreparationProgress,
} from "../../packages/provisioning/src/selection";
const abort = new AbortController();
let started = false;
process.on("disconnect", () => abort.abort());
process.on(
  "message",
  async (data: {
    type: string;
    source: string;
    output: string;
    selection: PackageSelection;
    sourcePlan?: PbfPlan;
    cachedSource?: VerifiedBuildSource;
  }) => {
    if (data.type === "cancel") {
      abort.abort();
      return;
    }
    if (data.type !== "start" || started) return;
    started = true;
    const { output } = data,
      work = output.replace(/\.atlas$/, ".work");
    let file: PackageSource | undefined,
      result: PackageSource | undefined,
      final: Record<string, unknown>;
    let last = 0,
      phase = "";
    const report = (p: PreparationProgress) => {
      if (
        performance.now() - last > 150 ||
        p.phase !== phase ||
        (p.total > 0 && p.completed === p.total)
      ) {
        if (process.connected)
          process.send?.({ type: "progress", progress: p });
        last = performance.now();
        phase = p.phase;
      }
    };
    try {
      const source = data.cachedSource
        ? await importCachedPbf(
            data.cachedSource,
            data.selection,
            work,
            abort.signal,
            report,
          )
        : data.sourcePlan
          ? await importPbf(
              data.sourcePlan,
              data.selection,
              join(dirname(output), "sources"),
              work,
              abort.signal,
              report,
            )
          : data.source;
      file = await PackageSource.open(source);
      abort.signal.throwIfAborted();
      const reader = await new AtlasReader(file).open();
      const selection =
        data.sourcePlan || data.cachedSource
          ? { ...data.selection, snapshot: reader.index.manifest.snapshot }
          : data.selection;
      const prepared = await preparePackage(
        reader,
        selection,
        output,
        abort.signal,
        report,
      );
      report({
        phase: "verifying",
        message: "Verifying the saved package…",
        completed: 0,
        total: 0,
        readBytes: reader.bytesRead,
        writtenBytes: prepared.size,
      });
      result = await PackageSource.open(output);
      const verified = await new AtlasReader(result).open();
      abort.signal.throwIfAborted();
      final = {
        type: "ready",
        size: result.size,
        manifest: verified.index.manifest,
      };
    } catch (error) {
      for (const path of [output, output + ".part", output + ".payload.part"])
        await rm(path, { force: true }).catch(() => {});
      final = {
        type: abort.signal.aborted ? "cancelled" : "failed",
        error: abort.signal.aborted ? "Preparation cancelled." : String(error),
      };
    } finally {
      await result?.close();
      await file?.close();
      if (!data.cachedSource || final!.type === "ready")
        await rm(work, { recursive: true, force: true });
    }
    if (process.connected) process.send?.(final);
    process.exit(0);
  },
);
