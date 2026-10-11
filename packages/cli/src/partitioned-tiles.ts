import { Database } from "bun:sqlite";
import geojsonvt from "geojson-vt";
import type { Feature, FeatureCollection } from "geojson";
import { project, TILE_EXTENT, layerForClass } from "../../format/src/index";
import { splitTile } from "../../format/src/tiles";
import type { PackageSelection } from "../../provisioning/src/selection";
import { bounds } from "../../offline/src/geometry";
import { selectedCell } from "../../offline/src/geometry";
import { encodeTile } from "./tile-codec";
import { displayMinZoom } from "./display";
import { BlockSpool } from "./block-spool";
import { measuredProgress } from "../../provisioning/src/compiler-progress";
/** Reuse the existing geometry codec and simplifier, with a bounded source batch and depth-first tile walk. */
export async function partitionTiles(
  source: Database,
  spool: BlockSpool,
  selection: PackageSelection,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const box = bounds(selection.polygon),
    nw = project(box[0], box[3]),
    se = project(box[2], box[1]);
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
    "Generating display tiles (source objects)",
    total,
    "objects",
    scanned,
  );
  let batch: Feature[] = [],
    size = 0,
    last = spool.cursor;
  async function flush() {
    if (!batch.length) return;
    spool.begin();
    for (const overview of [true, false]) {
      const lo = Math.max(selection.minZoom, overview ? 0 : 6),
        hi = Math.min(selection.maxZoom, overview ? 5 : 16);
      if (lo > hi) continue;
      const features = overview
        ? batch.filter((f) => displayMinZoom(f.properties ?? {}) <= 5)
        : batch;
      if (!features.length) continue;
      const index = geojsonvt(
        { type: "FeatureCollection", features },
        {
          maxZoom: selection.maxZoom,
          extent: TILE_EXTENT,
          buffer: 0,
          tolerance: overview ? 5 : TILE_EXTENT / 512,
          indexMaxZoom: 0,
          indexMaxPoints: 100000,
        },
      );
      const internals = index as unknown as {
        tiles: Record<
          number,
          { source: unknown; features: unknown[]; numFeatures: number }
        >;
        tileCoords: unknown[];
      };
      const id = (z: number, x: number, y: number) => (2 ** z * y + x) * 32 + z;
      function walk(z: number, x: number, y: number) {
        signal.throwIfAborted();
        const n = 2 ** z;
        if (
          x < Math.floor(nw[0] * n) ||
          x > Math.min(n - 1, Math.floor(se[0] * n)) ||
          y < Math.floor(nw[1] * n) ||
          y > Math.min(n - 1, Math.floor(se[1] * n))
        ) {
          delete internals.tiles[id(z, x, y)];
          return;
        }
        const tile = index.getTile(z, x, y);
        internals.tileCoords.length = 0;
        if (!tile) return;
        if (z >= lo && selectedCell(selection.polygon, z, x, y)) {
          const visible = tile.features.filter(
            (f) => z >= displayMinZoom(f.tags ?? {}),
          );
          if (visible.length)
            for (const part of splitTile(encodeTile(visible)))
              spool.add(`tile/${part.layer}/${z}/${x}/${y}`, part.bytes);
        }
        const t = internals.tiles[id(z, x, y)];
        if (z < hi && t?.numFeatures) {
          for (let dx = 0; dx < 2; dx++)
            for (let dy = 0; dy < 2; dy++) walk(z + 1, x * 2 + dx, y * 2 + dy);
        }
        delete internals.tiles[id(z, x, y)];
      }
      walk(0, 0, 0);
    }
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
