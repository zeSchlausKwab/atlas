import { compilerWorkers } from "../../compiler/src/settings";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { parallelMap } from "../../compiler/src/process-pool";
import { measuredProgress } from "../../provisioning/src/compiler-progress";
import {
  RECORDS_PER_PAGE,
  POSTINGS_PER_PAGE,
  ordinalKey,
  termKey,
  MAX_SEARCH_PAGE,
  type Term,
} from "./paging";
import type { IndexTask, IndexResult } from "./search-index-worker";
/** Build independent ordinal ranges, then stream a deterministic merge through the archive writer. */
export async function parallelNameIndex(
  source: Database,
  path: string,
  writer: BlockWriter,
  workers: number,
  signal: AbortSignal | undefined,
  progress: (line: string) => void,
) {
  compilerWorkers(workers);
  const total = source
    .query<{ n: number }, []>("SELECT count(*) AS n FROM locations")
    .get()!.n;
  if (total >= 2 ** 32) throw new Error("Search record identity overflow");
  const work = await mkdtemp(resolve(path) + ".parallel-");
  const merge = new Database(":memory:");
  try {
    const stride = Math.max(
      RECORDS_PER_PAGE,
      Math.ceil(total / workers / RECORDS_PER_PAGE) * RECORDS_PER_PAGE,
    );
    const tasks: IndexTask[] = [];
    const planProgress = measuredProgress(
      progress,
      "search-partitions",
      "Partitioning search records",
      total,
      "records",
    );
    let ordinal = 0;
    // One ordered scan for all boundaries; repeated OFFSET queries would rescan large sources.
    for (const { id } of source
      .query<{ id: string }, []>("SELECT id FROM locations ORDER BY id")
      .iterate()) {
      signal?.throwIfAborted();
      if (ordinal % stride === 0)
        tasks.push({
          source: resolve(path),
          path: `${work}/${tasks.length}.sqlite`,
          first: id,
          start: ordinal,
          count: Math.min(stride, total - ordinal),
        });
      if (++ordinal % 10000 === 0) {
        planProgress(ordinal);
        await Bun.sleep(0);
      }
    }
    if (ordinal !== total)
      throw new Error("Search source changed during partition planning");
    planProgress(total);
    const done = tasks.map(() => 0),
      sorted = tasks.map(() => false);
    const report = measuredProgress(
      progress,
      "search-records",
      `Building search name index (${tasks.length} workers)`,
      total,
      "records",
    );
    let sortProgress: ReturnType<typeof measuredProgress> | undefined;
    const results: IndexResult[] = [];
    for await (const { result } of parallelMap<IndexTask, IndexResult>(
      new URL("./search-index-worker.ts", import.meta.url),
      tasks,
      workers,
      signal,
      (i, value) => {
        done[i] = value.records;
        sorted[i] = value.sorted;
        const completed = done.reduce((a, b) => a + b, 0);
        if (!sortProgress) report(completed);
        if (completed === total) {
          sortProgress ??= measuredProgress(
            progress,
            "search-sort",
            "Sorting search shards",
            tasks.length,
            "blocks",
          );
          sortProgress(sorted.filter(Boolean).length);
        }
      },
      work,
    ))
      results.push(result);
    signal?.throwIfAborted();
    const encode = new TextEncoder();
    const write = async (key: string, value: unknown, features = 0) => {
      signal?.throwIfAborted();
      const bytes = encode.encode(JSON.stringify(value));
      if (bytes.length > MAX_SEARCH_PAGE)
        throw new Error(`${key} exceeds 4 MiB`);
      await writer.add({ key, bytes, features });
    };
    for (let i = 0; i < results.length; i++)
      merge.query(`ATTACH DATABASE ? AS shard${i}`).run(results[i]!.path);
    merge.run(
      "PRAGMA query_only=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096",
    );
    for (let i = 0; i < results.length; i++)
      merge.run(
        `PRAGMA shard${i}.cache_size=-4096; PRAGMA shard${i}.mmap_size=0`,
      );
    if (results.length) {
      const select = (columns: string, table: string) =>
        results
          .map((_, i) => `SELECT ${columns} FROM shard${i}.${table}`)
          .join(" UNION ALL ");
      const recordsReport = measuredProgress(
        progress,
        "search-record-pages",
        "Packing search records",
        total,
        "records",
      );
      let count = 0;
      for (const row of merge
        .query<
          { page: number; json: string; count: number },
          []
        >(select("page,json,count", "records") + " ORDER BY page")
        .iterate()) {
        signal?.throwIfAborted();
        await writer.add({
          key: ordinalKey("records", row.page),
          bytes: encode.encode(row.json),
          features: row.count,
        });
        count += row.count;
        recordsReport(count);
      }
      const postingReport = measuredProgress(
        progress,
        "search-postings",
        "Merging and packing search postings",
        results.reduce((n, r) => n + r.postings, 0),
        "records",
      );
      let posted = 0,
        postingPage = 0,
        bucket = -1,
        catalog: Term[] = [],
        term: Term | undefined,
        ids: number[] = [];
      const page = async () => {
        if (ids.length) {
          await write(ordinalKey("postings", postingPage++), {
            schema: "postings-v1",
            ids,
          });
          term!.pages++;
          ids = [];
        }
      };
      const finishTerm = async () => {
        if (term) {
          await page();
          catalog.push(term);
          if (catalog.length > 10000)
            throw new Error("Search term hash bucket is too large");
        }
      };
      for (const row of merge
        .query<
          { bucket: number; term: string; rid: number },
          []
        >(select("bucket,term,rid", "postings") + " ORDER BY bucket,term,rid")
        .iterate()) {
        if (!term || term.term !== row.term || bucket !== row.bucket) {
          await finishTerm();
          if (bucket !== row.bucket) {
            if (bucket >= 0)
              await write(termKey(bucket), {
                schema: "terms-v1",
                terms: catalog,
              });
            bucket = row.bucket;
            catalog = [];
          }
          term = { term: row.term, count: 0, start: postingPage, pages: 0 };
        }
        term.count++;
        ids.push(row.rid);
        if (ids.length === POSTINGS_PER_PAGE) await page();
        if (++posted % 10000 === 0) {
          signal?.throwIfAborted();
          postingReport(posted);
        }
      }
      await finishTerm();
      if (bucket >= 0)
        await write(termKey(bucket), { schema: "terms-v1", terms: catalog });
      postingReport(posted);
    }
    return { records: total, pages: Math.ceil(total / RECORDS_PER_PAGE) };
  } finally {
    merge.close();
    await rm(work, { recursive: true, force: true });
  }
}
