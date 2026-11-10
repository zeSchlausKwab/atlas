import { Database } from "bun:sqlite";
import { serveWorker } from "../../compiler/src/process-pool";
import { RECORDS_PER_PAGE, MAX_SEARCH_PAGE } from "./paging";
import { PostingSpool } from "./posting-spool";
import type { Location } from "./model";
export interface IndexTask {
  source: string;
  path: string;
  first: string;
  start: number;
  count: number;
}
export interface IndexResult {
  path: string;
  records: number;
  postings: number;
}
serveWorker<IndexTask, IndexResult>(async (task, report) => {
  const source = new Database(task.source, { readonly: true });
  const db = new Database(task.path, { create: true });
  try {
    source.run(
      "PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA mmap_size=0",
    );
    // Compact batches are inserted in key order by SQLite; no duplicate global sort index.
    db.run(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768;
      CREATE TABLE records(page INTEGER PRIMARY KEY,json TEXT,count INTEGER);
      BEGIN;`);
    const postings = new PostingSpool(db),
      put = db.query("INSERT INTO records VALUES(?,?,?)");
    let records = 0,
      page = task.start / RECORDS_PER_PAGE;
    let chunk: Location[] = [];
    const flush = () => {
      const json = JSON.stringify({ schema: "locations-v1", records: chunk });
      if (Buffer.byteLength(json) > MAX_SEARCH_PAGE)
        throw new Error("Search record page exceeds 4 MiB");
      put.run(page++, json, chunk.length);
      chunk = [];
    };
    for (const { json } of source
      .query<
        { json: string },
        [string, number]
      >("SELECT json FROM locations WHERE id>=? ORDER BY id LIMIT ?")
      .iterate(task.first, task.count)) {
      const r: Location = JSON.parse(json),
        rid = task.start + records;
      postings.add(r, rid);
      records++;
      chunk.push(r);
      if (chunk.length === RECORDS_PER_PAGE) flush();
      if (records % 2048 === 0) {
        report({ records, sorted: false });
        await Bun.sleep(0);
      }
    }
    if (chunk.length) flush();
    if (records !== task.count)
      throw new Error("Search source changed during parallel indexing");
    postings.flush();
    db.run("COMMIT");
    report({ records, sorted: true });
    return { path: task.path, records, postings: postings.count };
  } finally {
    db.close();
    source.close();
  }
});
