import type { Database } from "bun:sqlite";
import type { BlockWriter } from "../../cli/src/stream-writer";
import type { Polygon } from "geojson";
import booleanIntersects from "@turf/boolean-intersects";
import { ObjectWriter } from "./build";
import type { SourceObject } from "./model";
export async function writeSourceObjects(
  db: Database,
  writer: BlockWriter,
  region?: Polygon,
  signal?: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  const objects = new ObjectWriter(writer);
  let scanned = 0,
    omitted = 0;
  const encountered: Record<string, number> = Object.create(null);
  const total = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM source_objects")
    .get()!.n;
  try {
    for (const { data } of db
      .query<
        { data: Uint8Array },
        []
      >("SELECT data FROM source_objects ORDER BY cell,id")
      .iterate()) {
      signal?.throwIfAborted();
      const v: SourceObject = JSON.parse(
        new TextDecoder().decode(
          Bun.gunzipSync(data as Uint8Array<ArrayBuffer>),
        ),
      );
      encountered[v.id.split("/")[0]!] =
        (encountered[v.id.split("/")[0]!] ?? 0) + 1;
      if (!region || !v.geometry || booleanIntersects(v.geometry, region))
        await objects.add(v);
      else omitted++;
      if (++scanned % 1000 === 0) {
        progress(`Preserving source semantics · ${scanned}/${total} objects`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    objects.report.encountered = encountered;
    objects.report.omitted.outsideSelection = omitted;
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
      (stats.coordinates ?? 0) - (encountered.node ?? 0),
    );
    objects.report.scope += `; ${omitted} objects outside the selected geometry omitted`;
    progress(
      `Indexing ${scanned - omitted} source objects and their relationships`,
    );
    return await objects.finish();
  } finally {
    objects.close();
  }
}
