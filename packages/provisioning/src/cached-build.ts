import { BUILD_DISK_FLOOR, DISK_RESERVE, BUILD_STOP_MARGIN } from "./capacity";
import { importPartitionedCached } from "./partitioned-cached";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AtlasReader, FileSource } from "../../format/src/reader";
import {
  project,
  unproject,
  spatialAddress,
  type Manifest,
} from "../../format/src/index";
import { DiskWriter } from "../../cli/src/disk-writer";
import { fileHash } from "../../cli/src/source";
import { WORLD_SOURCE, importBounds } from "./global-source";
import type { CachedSource } from "./source-cache";
import {
  validateSelectionScope,
  type PackageSelection,
  type PreparationProgress,
} from "./selection";
import { runCompiler } from "./process";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GIB = 1024 ** 3;
export const CACHED_BUILD_VERSION = 1;
export const REGION_PBF_LIMIT = 256 * 1024 ** 2;
export const DETAIL_PARTITION_ZOOM = 9;
export const DETAIL_MIN_ZOOM = 12;
type Bounds = [number, number, number, number];
export interface VerifiedBuildSource extends CachedSource {
  path: string;
  sha256: string;
  mtimeMs: number;
}
export interface DisplayPartition {
  id: string;
  x: number;
  y: number;
  bounds: Bounds;
}
export interface CachedBuildPlan {
  partitioned?: true;
  bounds: Bounds;
  partitions: DisplayPartition[];
  candidateTiles: number;
}
export { cachedBuildSpace } from "./capacity";
/** Regional admission guard: graph and semantic indexes still require one bounded root. */
export function planCachedBuild(selection: PackageSelection): CachedBuildPlan {
  validateSelectionScope(selection, WORLD_SOURCE);
  const b = importBounds({ ...selection, maxSourceBytes: REGION_PBF_LIMIT });
  const nw = project(b[0], b[3]),
    se = project(b[2], b[1]);
  let candidateTiles = 0;
  for (let z = 0; z <= selection.maxZoom; z++) {
    const n = 2 ** z;
    candidateTiles +=
      (Math.floor(se[0] * n) - Math.floor(nw[0] * n) + 1) *
      (Math.floor(se[1] * n) - Math.floor(nw[1] * n) + 1);
  }
  const n = 2 ** DETAIL_PARTITION_ZOOM,
    partitions: DisplayPartition[] = [];
  const x0 = Math.floor(nw[0] * n),
    x1 = Math.min(n - 1, Math.floor(se[0] * n));
  const y0 = Math.floor(nw[1] * n),
    y1 = Math.min(n - 1, Math.floor(se[1] * n));
  if (
    selection.ocean ||
    (x1 - x0 + 1) * (y1 - y0 + 1) > 16 ||
    candidateTiles > 100000
  )
    return { bounds: b, partitions: [], candidateTiles, partitioned: true };
  if (selection.layers.length && selection.maxZoom >= DETAIL_MIN_ZOOM)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const lo = unproject(x / n, (y + 1) / n),
          hi = unproject((x + 1) / n, y / n);
        partitions.push({
          id: `${DETAIL_PARTITION_ZOOM}-${x}-${y}`,
          x,
          y,
          bounds: [
            Math.max(b[0], lo[0]),
            Math.max(b[1], lo[1]),
            Math.min(b[2], hi[0]),
            Math.min(b[3], hi[1]),
          ],
        });
      }
  return { bounds: b, partitions, candidateTiles };
}
export function ownsDetailTile(key: string, part: DisplayPartition) {
  const a = spatialAddress(key);
  if (!a || !a.prefix.startsWith("tile/") || a.z < DETAIL_MIN_ZOOM)
    return false;
  const scale = 2 ** (a.z - DETAIL_PARTITION_ZOOM);
  return (
    Math.floor(a.x / scale) === part.x && Math.floor(a.y / scale) === part.y
  );
}
interface Receipt {
  bytes: number;
  sha256: string;
}
interface Checkpoint {
  version: number;
  identity: string;
  completed: Record<string, Receipt>;
}
/** Only fully written, hash-verified stage artifacts are reusable. */
export class BuildCheckpoints {
  private state: Checkpoint;
  constructor(
    readonly directory: string,
    readonly identity: string,
  ) {
    this.state = { version: CACHED_BUILD_VERSION, identity, completed: {} };
  }
  async open() {
    await mkdir(this.directory, { recursive: true });
    const file = Bun.file(join(this.directory, "build.json"));
    if (await file.exists()) {
      const saved = (await file.json()) as Checkpoint;
      if (
        saved.identity !== this.identity ||
        saved.version !== CACHED_BUILD_VERSION
      )
        throw new Error(
          "Build recipe or compiler changed. Start a new preparation; these checkpoints belong to the previous build.",
        );
      this.state = saved;
    }
    // Unfinished compiler scratch is not a checkpoint. Process-group cancellation
    // can leave transport spools and JSON behind; don't accumulate them on resume.
    const keep = new Set(["build.json", ...Object.keys(this.state.completed)]);
    for (const name of await readdir(this.directory))
      if (!keep.has(name))
        await rm(join(this.directory, name), { recursive: true, force: true });
    return this;
  }
  get savedBytes() {
    return Object.values(this.state.completed).reduce(
      (sum, v) => sum + v.bytes,
      0,
    );
  }
  async reusable(
    name: string,
    progress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ) {
    const saved = this.state.completed[name],
      path = join(this.directory, name);
    if (!saved) return false;
    // An altered completed artifact is not silently mixed with downstream artifacts.
    if (
      (await stat(path)).size !== saved.bytes ||
      (await fileHash(path, progress, signal)) !== saved.sha256
    )
      throw new Error(
        `Completed build artifact ${name} changed on disk. Start a new preparation.`,
      );
    return true;
  }
  async complete(name: string) {
    const path = join(this.directory, name);
    this.state.completed[name] = {
      bytes: (await stat(path)).size,
      sha256: await fileHash(path),
    };
    const record = join(this.directory, "build.json");
    await Bun.write(record + ".tmp", JSON.stringify(this.state));
    await rename(record + ".tmp", record);
  }
}
export function cachedSourceDate(
  source: Pick<CachedSource, "url" | "lastModified">,
) {
  const date = source.url.match(/-(\d{2})(\d{2})(\d{2})\.osm\.pbf$/);
  return date
    ? `20${date[1]}-${date[2]}-${date[3]}`
    : source.lastModified.slice(0, 10);
}
export async function importCachedPbf(
  source: VerifiedBuildSource,
  selection: PackageSelection,
  work: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
  artifacts?: string,
) {
  const plan = planCachedBuild(selection);
  const sourceStat = await stat(source.path);
  if (sourceStat.size !== source.bytes || sourceStat.mtimeMs !== source.mtimeMs)
    throw new Error(
      "Verified PBF changed on disk. Select a verified source again.",
    );
  if (plan.partitioned || selection.ocean || artifacts)
    return importPartitionedCached(
      source,
      selection,
      work,
      plan.bounds,
      signal,
      report,
      artifacts,
    );
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        version: CACHED_BUILD_VERSION,
        source: source.sha256,
        selection,
        plan,
      }),
    )
    .digest("hex");
  const checkpoint = await new BuildCheckpoints(work, identity).open();
  const total = 3 + plan.partitions.length * 2;
  let stage = 0;
  const progress = (
    phase: PreparationProgress["phase"],
    message: string,
    stagePercent?: number,
  ) =>
    report({
      phase,
      message: `[${stage}/${total}] ${message}`,
      completed: stage - 1,
      total,
      unit: "stages",
      stagePercent,
      readBytes: 0,
      writtenBytes: checkpoint.savedBytes,
    });
  async function space() {
    const fs = await statfs(work);
    if (fs.bavail * fs.bsize < BUILD_DISK_FLOOR)
      throw new Error(
        `Build stopped to preserve ${DISK_RESERVE / 1024 ** 3} GiB free plus a ${BUILD_STOP_MARGIN / 1024 ** 3} GiB stopping buffer. Completed stages are saved; free space and resume.`,
      );
  }
  async function runStage(
    name: string,
    phase: PreparationProgress["phase"],
    message: string,
    build: (path: string) => Promise<void>,
  ) {
    stage++;
    signal.throwIfAborted();
    progress(phase, `Checking saved stage: ${message}`);
    if (await checkpoint.reusable(name)) {
      progress(phase, `Reused ${message}`);
      return;
    }
    await space();
    progress(phase, message);
    const output = join(work, name);
    await build(output);
    signal.throwIfAborted();
    await checkpoint.complete(name);
    report({
      phase,
      message: `[${stage}/${total}] Saved ${message}`,
      completed: stage,
      total,
      unit: "stages",
      readBytes: 0,
      writtenBytes: checkpoint.savedBytes,
    });
  }
  async function extract(input: string, output: string, bounds: Bounds) {
    const partial = output + ".part.osm.pbf",
      abort = new AbortController();
    let failure: Error | undefined;
    const check = async () => {
      try {
        await space();
        if (
          (await stat(partial).catch(() => ({ size: 0 }))).size >
          REGION_PBF_LIMIT
        )
          throw new Error(
            "Extract exceeds the current 256 MiB regional compiler limit. Choose a smaller area; the planet source remains cached.",
          );
      } catch (e) {
        failure = e as Error;
        abort.abort();
      }
    };
    const timer = setInterval(() => void check(), 2000);
    try {
      await runCompiler(
        [
          "osmium",
          "extract",
          input,
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
          partial,
        ],
        ROOT,
        AbortSignal.any([signal, abort.signal]),
        (line) => {
          const percent = line.match(/\]\s+(\d+)%/);
          if (percent)
            progress(
              "extracting",
              `Reading PBF · ${percent[1]}% of three extraction passes (the final pass writes the region)…`,
              Number(percent[1]),
            );
          else progress("extracting", line);
        },
      );
      await check();
      if (failure) throw failure;
      await runCompiler(["osmium", "check-refs", partial], ROOT, signal);
      await rename(partial, output);
    } catch (e) {
      throw failure ?? e;
    } finally {
      clearInterval(timer);
      await rm(partial, { force: true });
    }
  }
  async function compile(
    input: string,
    output: string,
    s: PackageSelection,
    b: Bounds,
  ) {
    const recipe = output + ".selection.json";
    await Bun.write(recipe, JSON.stringify(s));
    await Bun.write(
      input + ".source.json",
      JSON.stringify({
        url: source.url,
        inputs: [
          { url: source.url, bytes: source.bytes, sha256: source.sha256 },
        ],
        extraction: {
          bounds: plan.bounds,
          strategy: s.featureKinds.includes("boundaries")
            ? "smart; types=multipolygon,restriction,boundary; cached-build-v1"
            : "smart; types=multipolygon,restriction; cached-build-v1",
          sourceDate: cachedSourceDate(source),
        },
      }),
    );
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
        String(s.minZoom),
        "--max-zoom",
        String(s.maxZoom),
        "--bounds",
        b.join(","),
        "--selection",
        recipe,
        "--max-bytes",
        String(selection.maxBytes),
        "--no-source-features",
        ...(s.featureKinds.length ? ["--features"] : []),
      ],
      ROOT,
      signal,
      (line) => progress("compiling", line),
      { ...process.env, TMPDIR: work },
    );
    // JSON is not a checkpoint; release it after the archive is complete.
    for (const suffix of [".import.json", ".import.json.routing.bin"])
      await rm(output + suffix, { force: true });
  }
  const area = join(work, "area.osm.pbf");
  await runStage(
    "area.osm.pbf",
    "extracting",
    "Extracting the selected region from the cached planet (three local passes)…",
    (path) => extract(source.path, path, plan.bounds),
  );
  // Build one canonical graph + semantic root, and low zooms once. Detail partitions
  // never generate their own graph IDs or semantic objects.
  await runStage(
    "root.atlas",
    "compiling",
    "Building shared routing, search, features and overview…",
    (path) =>
      compile(
        area,
        path,
        {
          ...selection,
          minZoom: Math.min(selection.minZoom, DETAIL_MIN_ZOOM - 1),
          maxZoom: Math.min(selection.maxZoom, DETAIL_MIN_ZOOM - 1),
        },
        plan.bounds,
      ),
  );
  for (const part of plan.partitions) {
    const input = join(work, `${part.id}.osm.pbf`);
    // One z12 tile guard supplies geometry crossing the tile ownership boundary.
    const pad = 360 / 4096;
    const b: Bounds = [
      Math.max(plan.bounds[0], part.bounds[0] - pad),
      Math.max(plan.bounds[1], part.bounds[1] - pad),
      Math.min(plan.bounds[2], part.bounds[2] + pad),
      Math.min(plan.bounds[3], part.bounds[3] + pad),
    ];
    await runStage(
      `${part.id}.osm.pbf`,
      "extracting",
      `Extracting detail partition ${part.id}…`,
      (path) => extract(area, path, b),
    );
    await runStage(
      `${part.id}.atlas`,
      "compiling",
      `Compiling detail partition ${part.id}…`,
      (path) =>
        compile(
          input,
          path,
          {
            ...selection,
            minZoom: Math.max(selection.minZoom, DETAIL_MIN_ZOOM),
            maxZoom: selection.maxZoom,
            profiles: [],
            featureKinds: [],
            placeNames: false,
            streetNames: false,
            pois: false,
            search: false,
            reverse: false,
            peaks: false,
          },
          part.bounds,
        ),
    );
  }
  await runStage(
    "source.atlas",
    "packing",
    "Assembling one map and verifying every block…",
    async (output) => {
      const writer = await new DiskWriter(output, selection.maxBytes).open();
      let manifest: Manifest | undefined;
      try {
        for (const [name, part] of [
          ["root.atlas", undefined],
          ...plan.partitions.map((p) => [`${p.id}.atlas`, p]),
        ] as [string, DisplayPartition | undefined][]) {
          const reader = await new AtlasReader(
            new FileSource(Bun.file(join(work, name))),
          ).open();
          try {
            if (!part) manifest = reader.index.manifest;
            for (const block of await reader.allBlocks()) {
              signal.throwIfAborted();
              if (part && !ownsDetailTile(block.key, part)) continue;
              const a = spatialAddress(block.key);
              if (block.key.startsWith("tile/") && a && a.z < selection.minZoom)
                continue;
              await writer.add({
                key: block.key,
                z: block.z,
                x: block.x,
                y: block.y,
                features: block.features,
                bytes: await reader.block(block.key),
              });
              reader.cache.delete(block.key);
            }
          } finally {
            reader.dispose();
          }
        }
        const { snapshot, ...m } = manifest!;
        await writer.finish({
          ...m,
          minZoom: selection.minZoom,
          maxZoom: selection.maxZoom,
          transport: m.transport
            ? { ...m.transport, graphSnapshot: snapshot }
            : undefined,
          limitations: [
            ...m.limitations,
            "Cached-source regional build: disk-backed coordinates and partitioned detail tiles; shared graph and semantic indexes remain regional.",
          ],
        });
      } catch (e) {
        await writer.abort();
        throw e;
      }
    },
  );
  report({
    phase: "compiling",
    message: "All compiler stages complete; selecting the final polygon…",
    completed: total,
    total,
    unit: "stages",
    readBytes: 0,
    writtenBytes: checkpoint.savedBytes,
  });
  return join(work, "source.atlas");
}
