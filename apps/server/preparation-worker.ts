import { rm } from "node:fs/promises";
import { PackageSource } from "./package-source";
import { AtlasReader } from "../../packages/format/src/reader";
import { preparePackage } from "../../packages/provisioning/src/prepare";
import type { PackageSelection } from "../../packages/provisioning/src/selection";
const abort = new AbortController();
let started = false;
process.on(
  "message",
  async (data: {
    type: string;
    source: string;
    output: string;
    selection: PackageSelection;
  }) => {
    if (data.type === "cancel") {
      abort.abort();
      return;
    }
    if (started) return;
    started = true;
    const { source, output, selection } = data;
    let file: PackageSource | undefined, result: PackageSource | undefined;
    try {
      file = await PackageSource.open(source);
      abort.signal.throwIfAborted();
      const reader = await new AtlasReader(file).open();
      let last = 0;
      const prepared = await preparePackage(
        reader,
        selection,
        output,
        abort.signal,
        (p) => {
          if (
            performance.now() - last > 150 ||
            p.phase !== "packing" ||
            p.completed === p.total
          ) {
            process.send?.({ type: "progress", progress: p });
            last = performance.now();
          }
        },
      );
      process.send?.({
        type: "progress",
        progress: {
          phase: "verifying",
          message: "Verifying the saved package…",
          completed: 0,
          total: 0,
          readBytes: reader.bytesRead,
          writtenBytes: prepared.size,
        },
      });
      result = await PackageSource.open(output);
      const verified = await new AtlasReader(result).open();
      abort.signal.throwIfAborted();
      process.send?.({
        type: "ready",
        size: result.size,
        manifest: verified.index.manifest,
      });
    } catch (error) {
      for (const path of [output, output + ".part", output + ".payload.part"])
        await rm(path, { force: true }).catch(() => {});
      process.send?.({
        type: abort.signal.aborted ? "cancelled" : "failed",
        error: abort.signal.aborted ? "Preparation cancelled." : String(error),
      });
    } finally {
      await result?.close();
      await file?.close();
      process.exit(0);
    }
  },
);
