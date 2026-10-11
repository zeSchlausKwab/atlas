import { Database } from "bun:sqlite";
import { serveWorker } from "../../compiler/src/process-pool";
import { grams, termBucket, RECORDS_PER_PAGE, MAX_SEARCH_PAGE } from "./paging";
import { normalize, type Location } from "./model";
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
    // Append first, then external-sort once. Avoid random B-tree writes per search gram.
    db.run(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768;
      CREATE TABLE postings(bucket INTEGER,term TEXT,rid INTEGER);
      CREATE TABLE records(page INTEGER PRIMARY KEY,json TEXT,count INTEGER);
      BEGIN;`);
    const insert = db.query("INSERT INTO postings VALUES(?,?,?)"),
      put = db.query("INSERT INTO records VALUES(?,?,?)");
    let records = 0,
      postings = 0,
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
      for (const term of grams(
        [r.name, ...r.aliases, r.context ?? ""].map(normalize).join(" "),
      )) {
        insert.run(termBucket(term), term, rid);
        postings++;
      }
      for (const gram of grams(
        [r.name, ...r.aliases].map(normalize).join(" "),
      )) {
        const term = "n:" + gram;
        insert.run(termBucket(term), term, rid);
        postings++;
      }
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
    db.run("COMMIT");
    report({ records, sorted: false });
    db.run("CREATE INDEX posting_order ON postings(bucket,term,rid)");
    report({ records, sorted: true });
    return { path: task.path, records, postings };
  } finally {
    db.close();
    source.close();
  }
});
