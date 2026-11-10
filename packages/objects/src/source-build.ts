import type { Database } from "bun:sqlite";
import type { BlockWriter } from "../../cli/src/stream-writer";
import type { Polygon } from "geojson";
import booleanIntersects from "@turf/boolean-intersects";
import { measuredProgress } from "../../provisioning/src/compiler-progress";
import { ObjectWriter } from "./build";
import type { ObjectStaging } from "./staging";
import type { SourceObject } from "./model";

export async function writeSourceObjects(
  db: Database,
  writer: BlockWriter,
  region?: Polygon,
  signal?: AbortSignal,
  progress: (s: string) => void = () => {},
  additional: Iterable<SourceObject> = [],
  staging?: ObjectStaging,
) {
  const objects = new ObjectWriter(
    writer,
    db.filename + ".objects-index.sqlite",
    staging,
    signal,
  );
  const input = {
    scanned: 0,
    omitted: 0,
    lastCell: -9007199254740991,
    lastRow: 0,
    additional: 0,
    encountered: {} as Record<string, number>,
    ...objects.inputState,
  };
  const total = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM source_objects")
    .get()!.n;
  const report = measuredProgress(
    progress,
    "semantic-object-ingest",
    "Streaming source geometry and relationships",
    total,
    "objects",
    input.scanned,
  );
  const checkpoint = async () => {
    await objects.checkpoint(input);
    report(input.scanned, true);
    if (staging)
      progress(
        "ATLAS_PROGRESS " +
          JSON.stringify({
            stage: "semantic-object-ingest",
            message: "Streaming source geometry and relationships",
            completed: input.scanned,
            total,
            unit: "objects",
            checkpointAt: Date.now() / 1000,
            stagingBytes: staging.payloadBytes,
            indexBytes:
              staging.db
                .query<{ page_count: number }, []>("PRAGMA page_count")
                .get()!.page_count *
              staging.db
                .query<{ page_size: number }, []>("PRAGMA page_size")
                .get()!.page_size,
          }),
      );
  };
  try {
    if (!objects.ingestComplete) {
      // Native source_object_cells is ordered by (cell,rowid). Keep nearby payloads
      // together without a dataset-sized sort, and resume at the exact cell/row.
      const rows = db.prepare<
        { cell: number; rowid: number; data: Uint8Array },
        [number, number]
      >(
        "SELECT rowid,cell,data FROM source_objects WHERE (cell,rowid)>(?,?) ORDER BY cell,rowid",
      );
      try {
        for (const { cell, rowid, data } of rows.iterate(
          input.lastCell,
          input.lastRow,
        )) {
          signal?.throwIfAborted();
          const v: SourceObject = JSON.parse(
            new TextDecoder().decode(
              Bun.gunzipSync(data as Uint8Array<ArrayBuffer>),
            ),
          );
          const kind = v.id.split("/")[0]!;
          input.encountered[kind] = (input.encountered[kind] ?? 0) + 1;
          if (!region || !v.geometry || booleanIntersects(v.geometry, region))
            await objects.add(v);
          else input.omitted++;
          input.lastCell = cell;
          input.lastRow = rowid;
          if (++input.scanned % 10000 === 0) await checkpoint();
          if (input.scanned % 1000 === 0) {
            report(input.scanned);
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      } finally {
        rows.finalize();
      }
      let i = 0;
      for (const object of additional) {
        if (i++ < input.additional) continue;
        signal?.throwIfAborted();
        await objects.add(object);
        input.additional = i;
        if (i % 1000 === 0) await checkpoint();
      }
      await checkpoint();
      objects.report.encountered = input.encountered;
      objects.report.omitted.outsideSelection = input.omitted;
      const stats = JSON.parse(
        db
          .query<
            { json: string },
            []
          >("SELECT json FROM metadata WHERE key='stats'")
          .get()!.json,
      );
      objects.report.omitted.untaggedCoordinateNodes = Math.max(
        0,
        (stats.coordinates ?? 0) - (input.encountered.node ?? 0),
      );
      objects.report.scope += `; ${input.omitted} objects outside the selected geometry omitted`;
    }
    return await objects.finish(progress);
  } finally {
    objects.close();
  }
}
