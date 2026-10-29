import { importImage } from "../../packages/raster/src/image-import";
import type { ImageImport } from "../../packages/raster/src/image-plan";
import { buildCapabilities } from "../../packages/provisioning/src/build-capabilities";
import {
  composeCapabilities,
  type CapabilityChange,
} from "../../packages/provisioning/src/compose-capabilities";
import { familySelection } from "../../packages/provisioning/src/families";
import { downloadPbf } from "../../packages/provisioning/src/download";
import { stat } from "node:fs/promises";
import { readStorage } from "./storage";
import { DISK_RESERVE } from "../../packages/provisioning/src/capacity";
import {
  amendRouting,
  type RoutingAmendment,
} from "../../packages/provisioning/src/amend";
import {
  importCachedPbf,
  planCachedBuild,
  type VerifiedBuildSource,
} from "../../packages/provisioning/src/cached-build";
import { rm, rename } from "node:fs/promises";
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
    imageImport?: ImageImport;
    amendment?: { request: RoutingAmendment; target: string };
    capabilityChange?: {
      request: CapabilityChange;
      target: string;
      source?: VerifiedBuildSource;
      donor?: string;
      download?: PbfPlan;
      cache: string;
      rebuild: string[];
    };
  }) => {
    if (data.type === "cancel") {
      abort.abort();
      return;
    }
    if (data.type !== "start" || started) return;
    started = true;
    const { output } = data,
      work = output.replace(/\.atlas$/, ".work");
    let targetFile: PackageSource | undefined;
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
    let diskError: Error | undefined,
      checkingDisk = false;
    const checkDisk = async () => {
      if (checkingDisk || abort.signal.aborted) return;
      checkingDisk = true;
      try {
        const storage = await readStorage(dirname(output));
        if (storage.availableBytes < DISK_RESERVE)
          throw new Error(
            `Preparation stopped to preserve ${DISK_RESERVE / 1024 ** 3} GiB free. Source files and reusable checkpoints are retained.`,
          );
      } catch (e) {
        diskError = e instanceof Error ? e : new Error(String(e));
        abort.abort(diskError);
      } finally {
        checkingDisk = false;
      }
    };
    const diskTimer = setInterval(() => void checkDisk(), 1000);
    try {
      await checkDisk();
      abort.signal.throwIfAborted();
      if (data.imageImport) {
        await importImage(data.imageImport, work, output, abort.signal, report);
      } else if (data.capabilityChange) {
        const change = data.capabilityChange;
        targetFile = await PackageSource.open(change.target);
        const target = await new AtlasReader(targetFile).open();
        let addition: AtlasReader | undefined;
        try {
          let additionPath: string | undefined;
          if (change.rebuild.length) {
            let source = change.source;
            if (change.download) {
              const downloaded = await downloadPbf(
                change.download,
                join(change.cache, "regional"),
                abort.signal,
                (completed, cached) =>
                  report({
                    phase: "downloading",
                    message: `${cached ? "Reusing" : "Downloading"} pinned ${change.download!.region.name} PBF`,
                    completed,
                    total: change.download!.bytes,
                    unit: "bytes",
                    readBytes: completed,
                    writtenBytes: 0,
                  }),
              );
              if (downloaded.receipt.sha256 !== change.request.sourceSnapshot)
                throw new Error(
                  "Downloaded PBF does not match the original source snapshot",
                );
              source = {
                id: change.request.sourceId!,
                kind: "regional",
                name: change.download.region.name,
                url: downloaded.receipt.url,
                bytes: downloaded.receipt.bytes,
                sha256: downloaded.receipt.sha256,
                path: downloaded.path,
                mtimeMs: (await stat(downloaded.path)).mtimeMs,
                etag: downloaded.receipt.etag ?? "",
                md5: "",
                lastModified: downloaded.receipt.lastModified,
                inspectedAt: downloaded.receipt.fetchedAt,
              };
            }
            if (source)
              additionPath = await buildCapabilities(
                source,
                target.index.manifest,
                change.request,
                change.rebuild,
                work,
                abort.signal,
                report,
              );
            else if (change.donor) {
              file = await PackageSource.open(change.donor);
              const donor = await new AtlasReader(file).open();
              try {
                if (
                  donor.index.manifest.snapshot !==
                  change.request.sourceSnapshot
                )
                  throw new Error("Donor snapshot changed");
                const s = familySelection(
                  target.index.manifest,
                  change.rebuild,
                  change.request.name,
                  change.request.maxBytes,
                  change.request.paddingCells,
                );
                s.snapshot = donor.index.manifest.snapshot;
                // Grouped families only import categories actually retained in this donor.
                s.featureKinds = s.featureKinds.filter((k) =>
                  donor.index.manifest.featureKinds?.includes(k),
                );
                additionPath = output + ".addition.atlas";
                await preparePackage(
                  donor,
                  s,
                  additionPath,
                  abort.signal,
                  report,
                );
              } finally {
                donor.dispose();
                await file.close();
                file = undefined;
              }
            } else throw new Error("Missing amendment source");
            file = await PackageSource.open(additionPath!);
            addition = await new AtlasReader(file).open();
          }
          await composeCapabilities(
            target,
            addition,
            change.request,
            change.rebuild,
            output,
            abort.signal,
            report,
            async () => {
              const storage = await readStorage(dirname(output));
              if (storage.availableBytes < DISK_RESERVE)
                throw new Error(
                  "Amendment stopped at the free-space reserve. Original files and checkpoints are retained.",
                );
            },
          );
        } finally {
          target.dispose();
          addition?.dispose();
          await file?.close();
          file = undefined;
          await rm(output + ".addition.atlas", { force: true });
        }
      } else if (data.amendment) {
        file = await PackageSource.open(data.source);
        targetFile = await PackageSource.open(data.amendment.target);
        const target = await new AtlasReader(targetFile).open(),
          source = await new AtlasReader(file).open();
        try {
          await amendRouting(
            target,
            source,
            data.amendment.request,
            output,
            abort.signal,
            report,
            async () => {
              const storage = await readStorage(dirname(output));
              if (storage.availableBytes < DISK_RESERVE)
                throw new Error(
                  "Amendment stopped to preserve server free space. Original files are unchanged; free space and queue again.",
                );
            },
          );
        } finally {
          target.dispose();
          source.dispose();
        }
      } else {
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
                join(dirname(output), "../sources/regional"),
                work,
                abort.signal,
                report,
              )
            : data.source;
        if (data.cachedSource && planCachedBuild(data.selection).partitioned) {
          // The partitioned compiler already applies the exact capability/polygon selection.
          // Move the completed archive; avoid rewriting Europe through the regional excerpt path.
          abort.signal.throwIfAborted();
          await rename(source, output);
        } else {
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
        }
      }
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
        type: abort.signal.aborted && !diskError ? "cancelled" : "failed",
        error: diskError
          ? diskError.message
          : abort.signal.aborted
            ? "Preparation cancelled."
            : String(error),
      };
    } finally {
      clearInterval(diskTimer);
      await result?.close();
      await file?.close();
      await targetFile?.close();
      if (
        (!data.cachedSource && !data.capabilityChange && !data.imageImport) ||
        final!.type === "ready"
      )
        await rm(work, { recursive: true, force: true });
    }
    if (process.connected) process.send?.(final);
    process.exit(0);
  },
);
