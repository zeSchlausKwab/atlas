import { Database } from "bun:sqlite";
import type { BlockWriter } from "./stream-writer";
import { decodeLabels } from "../../labels/src/index";
import { decodePlaces } from "../../labels/src/places";
import { decodeFeatures } from "../../features/src/index";
import { tileRecords } from "../../format/src/tiles";
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
/** A durable fragment spool: commits make a complete source batch resumable. */
export class BlockSpool {
  readonly db: Database;
  private sequence = 0;
  constructor(
    readonly path: string,
    readonly identity: string,
  ) {
    this.db = new Database(path);
    this.db
      .run(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768;
    CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fragments(key TEXT,seq INTEGER,data BLOB,PRIMARY KEY(key,seq)) WITHOUT ROWID;`);
    const old = this.db
      .query<
        { value: string },
        []
      >("SELECT value FROM state WHERE key='identity'")
      .get();
    if (old && old.value !== identity)
      throw new Error("Fragment spool belongs to another source or recipe");
    this.db
      .query("INSERT OR IGNORE INTO state VALUES('identity',?)")
      .run(identity);
    this.sequence = Number(
      this.db
        .query<
          { value: string },
          []
        >("SELECT value FROM state WHERE key='sequence'")
        .get()?.value ?? 0,
    );
  }
  get cursor() {
    return Number(
      this.db
        .query<
          { value: string },
          []
        >("SELECT value FROM state WHERE key='cursor'")
        .get()?.value ?? 0,
    );
  }
  begin() {
    this.db.run("BEGIN");
  }
  checkpoint(cursor: number) {
    this.db
      .query(
        "INSERT INTO state VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(cursor));
    this.db
      .query(
        "INSERT INTO state VALUES('sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(this.sequence));
    this.db.run("COMMIT");
  }
  add(key: string, bytes: Uint8Array) {
    this.db
      .query("INSERT INTO fragments VALUES(?,?,?)")
      .run(
        key,
        ++this.sequence,
        Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>),
      );
  }
  json(key: string, value: unknown) {
    this.add(key, encoder.encode(JSON.stringify(value)));
  }
  get blockCount() {
    return this.db
      .query<
        { n: number },
        []
      >("SELECT count(DISTINCT key) AS n FROM fragments")
      .get()!.n;
  }
  async write(
    writer: BlockWriter,
    signal: AbortSignal,
    progress: (key: string, completed: number) => void,
  ) {
    let completed = 0;
    for (const { key } of this.db
      .query<
        { key: string },
        []
      >("SELECT DISTINCT key FROM fragments ORDER BY key")
      .iterate()) {
      signal.throwIfAborted();
      const parts: Uint8Array[] = [];
      let length = 0;
      for (const { data } of this.db
        .query<
          { data: Uint8Array },
          [string]
        >("SELECT data FROM fragments WHERE key=? ORDER BY seq")
        .iterate(key)) {
        const bytes = Bun.gunzipSync(data as Uint8Array<ArrayBuffer>);
        length += bytes.length;
        if (length > 64 * 1024 * 1024)
          throw new Error(
            `Block ${key} exceeds 64 MiB; finer partitioning is required`,
          );
        parts.push(bytes);
      }
      let bytes: Uint8Array, features: number;
      if (key.startsWith("tile/")) {
        const records = parts
          .flatMap((p) =>
            [...tileRecords(p)].map((r) => ({
              bytes: p.subarray(r.start, r.end),
              class: r.class,
              points: r.pointCount,
            })),
          )
          .sort((a, b) => a.class - b.class);
        features = records.length;
        if (records.reduce((n, r) => n + r.points, 0) > 3000000)
          throw new Error(`Tile ${key} exceeds its point limit`);
        if (features > 500000)
          throw new Error(`Tile ${key} exceeds its feature limit`);
        bytes = new Uint8Array(
          8 + records.reduce((n, r) => n + r.bytes.length, 0),
        );
        bytes.set(encoder.encode("TIL2"));
        new DataView(bytes.buffer).setUint32(4, features, true);
        let at = 8;
        for (const r of records) {
          bytes.set(r.bytes, at);
          at += r.bytes.length;
        }
      } else {
        const values = parts.map((p) => JSON.parse(decoder.decode(p)));
        let value: unknown;
        if (key.startsWith("features/")) {
          const records = values.flatMap((v) => v.features);
          features = records.length;
          value = { schema: "features-v1", features: records };
        } else if (key.startsWith("labels/settlements/")) {
          const places = values.flatMap((v) => v.places);
          features = places.length;
          value = { schema: "places-v1", places };
        } else if (key.startsWith("labels/")) {
          const roads = values.flatMap((v) => v.roads),
            pois = values.flatMap((v) => v.pois);
          features = roads.length + pois.length;
          value = { schema: "labels-v1", roads, pois };
        } else {
          const records = values.flat();
          features = records.length;
          value = records;
        }
        bytes = encoder.encode(JSON.stringify(value));
      }
      if (key.startsWith("features/")) decodeFeatures(bytes);
      else if (key.startsWith("labels/settlements/")) decodePlaces(bytes);
      else if (key.startsWith("labels/")) decodeLabels(bytes);
      await writer.add({ key, bytes, features });
      progress(key, ++completed);
    }
  }
  close() {
    this.db.close();
  }
}
