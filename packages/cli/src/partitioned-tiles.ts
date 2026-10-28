import { compilerWorkers } from "../../compiler/src/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { parallelMap } from "../../compiler/src/process-pool";
import { renderTileBatch } from "./tile-batch";
import type { TileTask } from "./tile-batch-worker";
import { Database } from "bun:sqlite";
import type { Feature } from "geojson";
import { layerForClass } from "../../format/src/index";
import type { PackageSelection } from "../../provisioning/src/selection";
import { BlockSpool } from "./block-spool";
import { measuredProgress } from "../../provisioning/src/compiler-progress";
/** Reuse the existing geometry codec and simplifier, with a bounded source batch and depth-first tile walk. */
export async function partitionTiles(
  source: Database,
  spool: BlockSpool,
  selection: PackageSelection,
  signal: AbortSignal,
  progress: (message: string) => void,
  workers = 1,
) {
  compilerWorkers(workers);
  const startCursor = spool.cursor,
    stride = 2 ** 32;
  const total = source
    .query<{ n: number }, []>("SELECT count(*) AS n FROM features")
    .get()!.n;
  let scanned = startCursor
    ? source
        .query<
          { n: number },
          [number, number, number]
        >("SELECT count(*) AS n FROM features WHERE cell<? OR (cell=? AND rowid<=?)")
        .get(
          Math.floor(startCursor / stride),
          Math.floor(startCursor / stride),
          startCursor % stride,
        )!.n
    : 0;
  const report = measuredProgress(
    progress,
    "display-geometry",
    `Generating display tiles (${workers} workers; source objects)`,
    total,
    "objects",
    scanned,
  );
  if (workers > 1) {
    const work = await mkdtemp(spool.path + ".parallel-");
    let batchIndex = 0;
    async function* tasks(): AsyncGenerator<TileTask> {
      let features: Feature[] = [],
        size = 0,
        last = startCursor,
        saved = startCursor;
      const cell = Math.floor(startCursor / stride),
        rowid = startCursor % stride;
      const rows = source.prepare<
        { rowid: number; cell: number; data: Uint8Array },
        [number, number, number]
      >(
        "SELECT rowid,cell,data FROM features WHERE cell>? OR (cell=? AND rowid>?) ORDER BY cell,rowid",
      );
      async function save() {
        const input = `${work}/${batchIndex}.json`,
          output = `${work}/${batchIndex++}.sqlite`;
        await Bun.write(input, JSON.stringify(features));
        features = [];
        size = 0;
        saved = last;
        return { input, output, selection, cursor: last, scanned };
      }
      try {
        for (const row of rows.iterate(cell, cell, rowid)) {
          signal.throwIfAborted();
          if (row.rowid >= stride)
            throw new Error("Source object identity limit exceeded");
          last = row.cell * stride + row.rowid;
          scanned++;
          const bytes = Bun.gunzipSync(row.data as Uint8Array<ArrayBuffer>);
          if (bytes.length > 32 * 1024 * 1024)
            throw new Error(
              "One source geometry exceeds the 32 MiB tiling budget",
            );
          const f: Feature = JSON.parse(new TextDecoder().decode(bytes));
          if (
            Number(f.properties?.class) < 8 &&
            selection.layers.includes(
              layerForClass(Number(f.properties?.class)),
            )
          ) {
            features.push(f);
            size += bytes.length;
          }
          if (size >= 4 * 1024 * 1024 || features.length >= 5000)
            yield await save();
          if (last > saved && !features.length && scanned % 5000 === 0) {
            yield await save();
          }
        }
        if (last > saved) yield await save();
      } finally {
        rows.finalize();
      }
    }
    try {
      for await (const { input } of parallelMap<TileTask, null>(
        new URL("./tile-batch-worker.ts", import.meta.url),
        tasks(),
        workers,
        signal,
        undefined,
        work,
      )) {
        signal.throwIfAborted();
        spool.begin();
        spool.appendFrom(input.output);
        spool.checkpoint(input.cursor);
        report(input.scanned, true);
        await rm(input.input, { force: true });
        await rm(input.output, { force: true });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return;
  }
  let batch: Feature[] = [],
    size = 0,
    last = spool.cursor;
  async function flush() {
    if (!batch.length) return;
    spool.begin();
    renderTileBatch(batch, selection, signal, (key, bytes) =>
      spool.add(key, bytes),
    );
    spool.checkpoint(last);
    batch = [];
    size = 0;
    report(scanned, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // The cell index already orders by (cell,rowid); keyset resume avoids sorting
  // continent-sized geometry blobs into another temporary table.
  const start = spool.cursor,
    cell = Math.floor(start / stride),
    rowid = start % stride;
  const rows = source.prepare<
    { rowid: number; cell: number; data: Uint8Array },
    [number, number, number]
  >(
    "SELECT rowid,cell,data FROM features WHERE cell>? OR (cell=? AND rowid>?) ORDER BY cell,rowid",
  );
  try {
    for (const row of rows.iterate(cell, cell, rowid)) {
      signal.throwIfAborted();
      if (row.rowid >= stride)
        throw new Error("Source object identity limit exceeded");
      last = row.cell * stride + row.rowid;
      scanned++;
      const bytes = Bun.gunzipSync(row.data as Uint8Array<ArrayBuffer>);
      if (bytes.length > 32 * 1024 * 1024)
        throw new Error("One source geometry exceeds the 32 MiB tiling budget");
      const f: Feature = JSON.parse(new TextDecoder().decode(bytes));
      if (
        Number(f.properties?.class) >= 8 ||
        !selection.layers.includes(layerForClass(Number(f.properties?.class)))
      )
        continue;
      batch.push(f);
      size += bytes.length;
      if (size >= 4 * 1024 * 1024 || batch.length >= 5000) await flush();
    }
    await flush();
    report(scanned);
  } finally {
    rows.finalize();
  }
}
