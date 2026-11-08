import {
  PostingSpool,
  decodePostingChunk,
  type PostingChunk,
} from "./posting-spool";
import { writeSearchCell } from "./cell-build";
import { parallelNameIndex } from "./parallel-index";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { project } from "../../format/src/index";
import { validPosition, type Location, type Street } from "./model";
import {
  termKey,
  ordinalKey,
  RECORDS_PER_PAGE,
  POSTINGS_PER_PAGE,
  STREET_ZOOM,
  MAX_SEARCH_PAGE,
  type Term,
} from "./paging";
import { measuredProgress } from "../../provisioning/src/compiler-progress";
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
    options: { search: boolean; reverse: boolean; workers?: number } = {
      search: true,
      reverse: true,
    },
    signal?: AbortSignal,
    progress: (message: string) => void = () => {},
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
      recordPage = 0,
      locationPage = 0,
      streetPage = 0;
    if (options.search) {
      if ((options.workers ?? 1) > 1) {
        const result = await parallelNameIndex(
          this.db,
          this.path,
          writer,
          options.workers!,
          signal,
          progress,
        );
        records = result.records;
        recordPage = result.pages;
      } else {
        const recordProgress = measuredProgress(
          progress,
          "search-records",
          "Building search name index",
          this.db
            .query<{ n: number }, []>("SELECT count(*) AS n FROM locations")
            .get()!.n,
          "records",
        );
        this.db.run("BEGIN");
        let chunk: Location[] = [];
        const postings = new PostingSpool(this.db);
        for (const { json } of this.db
          .query<{ json: string }, []>("SELECT json FROM locations ORDER BY id")
          .iterate()) {
          signal?.throwIfAborted();
          const r: Location = JSON.parse(json);
          if (records >= 2 ** 32)
            throw new Error("Search record identity overflow");
          postings.add(r, records);
          records++;
          if (records % 10000 === 0) recordProgress(records);
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
        postings.flush();
        recordProgress(records);
        this.db.run("COMMIT");
        const postingProgress = measuredProgress(
          progress,
          "search-postings",
          "Packing search postings",
          this.db
            .query<
              { n: number },
              []
            >("SELECT coalesce(sum(count),0) AS n FROM postings")
            .get()!.n,
          "records",
        );
        let posted = 0;
        let postingPage = 0,
          bucket = -1,
          catalog: Term[] = [];
        // GROUP BY follows the on-disk primary key; only one bucket/catalog and one posting page are resident.
        for (const row of this.db
          .query<
            { bucket: number; term: string; count: number },
            []
          >("SELECT bucket,term,sum(count) AS count FROM postings GROUP BY bucket,term ORDER BY bucket,term")
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
          for (const chunk of this.db
            .query<
              PostingChunk,
              [number, string]
            >("SELECT first,count,data FROM postings WHERE bucket=? AND term=? ORDER BY first")
            .iterate(bucket, row.term)) {
            signal?.throwIfAborted();
            for (const rid of decodePostingChunk(chunk)) {
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
          }
          if (ids.length) {
            await write(ordinalKey("postings", postingPage++), {
              schema: "postings-v1",
              ids,
            });
            term.pages++;
          }
          posted += row.count;
          postingProgress(posted);
          catalog.push(term);
          if (catalog.length > 10000)
            throw new Error("Search term hash bucket is too large");
        }
        if (bucket >= 0)
          await write(termKey(bucket), { schema: "terms-v1", terms: catalog });
      }
      const n = 2 ** STREET_ZOOM;
      let completedCells = 0;
      const cellsProgress = measuredProgress(
        progress,
        "search-cells",
        "Packing location search cells",
        this.db
          .query<
            { n: number },
            []
          >("SELECT count(DISTINCT cell) AS n FROM locations")
          .get()!.n,
        "cells",
      );
      for (const { cell } of this.db
        .query<
          { cell: number },
          []
        >("SELECT DISTINCT cell FROM locations ORDER BY cell")
        .iterate()) {
        await writeSearchCell(
          "locations",
          `search/locations-data/${STREET_ZOOM}/${Math.floor(cell / n)}/${cell % n}`,
          this.db
            .query<
              { json: string },
              [number]
            >("SELECT json FROM locations WHERE cell=? ORDER BY id")
            .iterate(cell),
          () => ordinalKey("location-pages", locationPage++),
          write,
          signal,
        );
        cellsProgress(++completedCells);
      }
      await write(
        "search/locations",
        {
          schema: "locations-paged-v1",
          names: true,
          records,
          pages: recordPage,
        },
        records,
      );
    }
    let streets = 0;
    if (options.reverse) {
      const n = 2 ** STREET_ZOOM;
      let completedCells = 0;
      const cellsProgress = measuredProgress(
        progress,
        "reverse-cells",
        "Packing nearest-street cells",
        this.db
          .query<
            { n: number },
            []
          >("SELECT count(DISTINCT cell) AS n FROM streets")
          .get()!.n,
        "cells",
      );
      for (const { cell } of this.db
        .query<
          { cell: number },
          []
        >("SELECT DISTINCT cell FROM streets ORDER BY cell")
        .iterate()) {
        await writeSearchCell(
          "streets",
          `search/streets-data/${STREET_ZOOM}/${Math.floor(cell / n)}/${cell % n}`,
          this.db
            .query<
              { json: string },
              [number]
            >("SELECT json FROM streets WHERE cell=? ORDER BY id")
            .iterate(cell),
          () => ordinalKey("street-pages", streetPage++),
          write,
          signal,
        );
        cellsProgress(++completedCells);
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
