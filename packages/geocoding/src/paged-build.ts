import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { project } from "../../format/src/index";
import { normalize, validPosition, type Location, type Street } from "./model";
import {
  grams,
  termBucket,
  termKey,
  ordinalKey,
  RECORDS_PER_PAGE,
  POSTINGS_PER_PAGE,
  STREET_ZOOM,
  MAX_SEARCH_PAGE,
  type Term,
} from "./paging";
const encoder = new TextEncoder();
/** External-memory search construction. Input records may arrive in arbitrary order. */
export class PagedSearchBuilder {
  private db: Database;
  private inserts = 0;
  constructor(readonly path: string) {
    this.db = new Database(path, { create: true });
    this.db
      .run(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768;
      CREATE TABLE locations(id TEXT PRIMARY KEY, cell INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX locations_cell ON locations(cell,id);
      CREATE TABLE streets(cell INTEGER, id TEXT, json TEXT, PRIMARY KEY(cell,id)) WITHOUT ROWID;
      CREATE TABLE postings(bucket INTEGER, term TEXT, rid INTEGER, PRIMARY KEY(bucket,term,rid)) WITHOUT ROWID;
      BEGIN;`);
  }
  private tick() {
    if (++this.inserts % 10000 === 0) this.db.run("COMMIT; BEGIN;");
  }
  addLocation(record: Location) {
    if (!validPosition(record.coordinates))
      throw new Error("Invalid search coordinates");
    const n = 2 ** STREET_ZOOM,
      [x, y] = project(...record.coordinates);
    const cell =
      Math.max(0, Math.min(n - 1, Math.floor(x * n))) * n +
      Math.max(0, Math.min(n - 1, Math.floor(y * n)));
    this.db
      .query(
        "INSERT INTO locations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cell=excluded.cell,json=excluded.json",
      )
      .run(record.id, cell, JSON.stringify(record));
    this.tick();
  }
  addStreet(street: Street) {
    if (
      street.coordinates.length < 2 ||
      !street.coordinates.every(validPosition)
    )
      throw new Error("Invalid street coordinates");
    const n = 2 ** STREET_ZOOM;
    let x0 = n - 1,
      y0 = n - 1,
      x1 = 0,
      y1 = 0;
    for (const p of street.coordinates) {
      const a = project(...p),
        x = Math.max(0, Math.min(n - 1, Math.floor(a[0] * n))),
        y = Math.max(0, Math.min(n - 1, Math.floor(a[1] * n)));
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096)
      throw new Error(`Street ${street.id} spans too many search cells`);
    const json = JSON.stringify(street),
      insert = this.db.query(
        "INSERT INTO streets VALUES(?,?,?) ON CONFLICT(cell,id) DO UPDATE SET json=excluded.json",
      );
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        insert.run(
          x * n + y,
          street.id +
            ":" +
            new Bun.CryptoHasher("sha256")
              .update(JSON.stringify(street.coordinates))
              .digest("hex"),
          json,
        );
    this.tick();
  }
  async finish(
    writer: BlockWriter,
    options = { search: true, reverse: true },
    signal?: AbortSignal,
  ) {
    this.db.run("COMMIT");
    const write = async (key: string, value: unknown, features = 0) => {
      signal?.throwIfAborted();
      const bytes = encoder.encode(JSON.stringify(value));
      if (bytes.length > MAX_SEARCH_PAGE)
        throw new Error(`${key} exceeds the 4 MiB search page limit`);
      await writer.add({ key, bytes, features });
    };
    let records = 0,
      recordPage = 0;
    if (options.search) {
      this.db.run("BEGIN");
      let chunk: Location[] = [];
      const insert = this.db.query("INSERT INTO postings VALUES(?,?,?)");
      for (const { json } of this.db
        .query<{ json: string }, []>("SELECT json FROM locations ORDER BY id")
        .iterate()) {
        signal?.throwIfAborted();
        const r: Location = JSON.parse(json);
        if (records >= 2 ** 32)
          throw new Error("Search record identity overflow");
        const terms = grams(
          [r.name, ...r.aliases, r.context ?? ""].map(normalize).join(" "),
        );
        for (const term of terms) insert.run(termBucket(term), term, records);
        records++;
        chunk.push(r);
        if (chunk.length === RECORDS_PER_PAGE) {
          await write(
            ordinalKey("records", recordPage++),
            { schema: "locations-v1", records: chunk },
            chunk.length,
          );
          chunk = [];
        }
      }
      if (chunk.length)
        await write(
          ordinalKey("records", recordPage++),
          { schema: "locations-v1", records: chunk },
          chunk.length,
        );
      this.db.run("COMMIT");
      let postingPage = 0,
        bucket = -1,
        catalog: Term[] = [];
      // GROUP BY follows the on-disk primary key; only one bucket/catalog and one posting page are resident.
      for (const row of this.db
        .query<
          { bucket: number; term: string; count: number },
          []
        >("SELECT bucket,term,count(*) AS count FROM postings GROUP BY bucket,term ORDER BY bucket,term")
        .iterate()) {
        if (bucket !== row.bucket) {
          if (bucket >= 0)
            await write(termKey(bucket), {
              schema: "terms-v1",
              terms: catalog,
            });
          bucket = row.bucket;
          catalog = [];
        }
        const term: Term = {
          term: row.term,
          count: row.count,
          start: postingPage,
          pages: 0,
        };
        let ids: number[] = [];
        for (const { rid } of this.db
          .query<
            { rid: number },
            [number, string]
          >("SELECT rid FROM postings WHERE bucket=? AND term=? ORDER BY rid")
          .iterate(bucket, row.term)) {
          ids.push(rid);
          if (ids.length === POSTINGS_PER_PAGE) {
            await write(ordinalKey("postings", postingPage++), {
              schema: "postings-v1",
              ids,
            });
            term.pages++;
            ids = [];
          }
        }
        if (ids.length) {
          await write(ordinalKey("postings", postingPage++), {
            schema: "postings-v1",
            ids,
          });
          term.pages++;
        }
        catalog.push(term);
        if (catalog.length > 10000)
          throw new Error("Search term hash bucket is too large");
      }
      if (bucket >= 0)
        await write(termKey(bucket), { schema: "terms-v1", terms: catalog });
      const n = 2 ** STREET_ZOOM;
      for (const { cell } of this.db
        .query<
          { cell: number },
          []
        >("SELECT DISTINCT cell FROM locations ORDER BY cell")
        .iterate()) {
        const values: Location[] = [];
        let bytes = 0;
        for (const { json } of this.db
          .query<
            { json: string },
            [number]
          >("SELECT json FROM locations WHERE cell=? ORDER BY id")
          .iterate(cell)) {
          if ((bytes += encoder.encode(json).length) > MAX_SEARCH_PAGE)
            throw new Error(
              "Location cell exceeds 4 MiB; use finer partitioning",
            );
          values.push(JSON.parse(json));
        }
        await write(
          `search/locations-data/${STREET_ZOOM}/${Math.floor(cell / n)}/${cell % n}`,
          { schema: "locations-v1", records: values },
          values.length,
        );
      }
      await write(
        "search/locations",
        { schema: "locations-paged-v1", records, pages: recordPage },
        records,
      );
    }
    let streets = 0;
    if (options.reverse) {
      const n = 2 ** STREET_ZOOM;
      for (const { cell } of this.db
        .query<
          { cell: number },
          []
        >("SELECT DISTINCT cell FROM streets ORDER BY cell")
        .iterate()) {
        const values: Street[] = [];
        let bytes = 0;
        for (const { json } of this.db
          .query<
            { json: string },
            [number]
          >("SELECT json FROM streets WHERE cell=? ORDER BY id")
          .iterate(cell)) {
          if ((bytes += encoder.encode(json).length) > MAX_SEARCH_PAGE)
            throw new Error(
              "Reverse street cell exceeds 4 MiB; use finer partitioning",
            );
          values.push(JSON.parse(json));
        }
        await write(
          `search/streets-data/${STREET_ZOOM}/${Math.floor(cell / n)}/${cell % n}`,
          { schema: "streets-v1", streets: values },
          values.length,
        );
      }
      streets = this.db
        .query<{ n: number }, []>("SELECT count(DISTINCT id) AS n FROM streets")
        .get()!.n;
      await write(
        "search/streets",
        { schema: "streets-paged-v1", streets, zoom: STREET_ZOOM },
        streets,
      );
    }
    return { records, streets };
  }
  async dispose() {
    this.db.close();
    await rm(this.path, { force: true });
    await rm(this.path + "-journal", { force: true });
  }
}
