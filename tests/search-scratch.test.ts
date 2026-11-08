import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { parallelMap } from "../packages/compiler/src/process-pool";
import type {
  IndexTask,
  IndexResult,
} from "../packages/geocoding/src/search-index-worker";

test("address indexing keeps temporary postings compact without duplicating a row per text gram", async () => {
  const dir = await mkdtemp("/tmp/atlas-search-storage-");
  const count = 20000;
  const source = new Database(`${dir}/source.sqlite`);
  try {
    source.run(
      "CREATE TABLE locations(id TEXT PRIMARY KEY,json TEXT) WITHOUT ROWID; BEGIN",
    );
    const insert = source.query("INSERT INTO locations VALUES(?,?)");
    for (let i = 0; i < count; i++) {
      const id = String(i).padStart(6, "0");
      insert.run(
        id,
        JSON.stringify({
          id,
          name: `Hauptstraße ${i % 200}`,
          aliases: [`Main Street ${i % 200}`],
          context: "Düsseldorf Nordrhein-Westfalen Deutschland",
          kind: "address",
          category: "house",
          coordinates: [6.8, 51.2],
        }),
      );
    }
    source.run("COMMIT");
    const results: IndexResult[] = [];
    for await (const { result } of parallelMap<IndexTask, IndexResult>(
      new URL(
        "../packages/geocoding/src/search-index-worker.ts",
        import.meta.url,
      ),
      [
        {
          source: `${dir}/source.sqlite`,
          path: `${dir}/index.sqlite`,
          first: "000000",
          start: 0,
          count,
        },
      ],
      1,
      undefined,
      undefined,
      dir,
    ))
      results.push(result);
    expect(results[0]!.records).toBe(count);
    expect(results[0]!.postings).toBe(4226200);
    // The old row-per-gram table plus sorting index needed ~158 MB here.
    // Include the record pages, so this catches both posting and record duplication.
    expect((await stat(`${dir}/index.sqlite`)).size).toBeLessThan(count * 500);
  } finally {
    source.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("compressed posting batches preserve uint32 IDs and reject malformed chunks", async () => {
  const { encodePostingChunk, decodePostingChunk } = await import(
    "../packages/geocoding/src/posting-spool"
  );
  for (const ids of [
    [0],
    [1, 2, 500, 4294967295],
    Array.from({ length: 10000 }, (_, i) => i + 1000),
  ]) {
    const data = encodePostingChunk(ids);
    expect([
      ...decodePostingChunk({ first: ids[0]!, count: ids.length, data }),
    ]).toEqual(ids);
    expect(() =>
      decodePostingChunk({ first: ids[0]! + 1, count: ids.length, data }),
    ).toThrow();
    expect(() =>
      decodePostingChunk({ first: ids[0]!, count: ids.length + 1, data }),
    ).toThrow();
    expect(() =>
      decodePostingChunk({
        first: ids[0]!,
        count: ids.length,
        data: data.subarray(0, data.length - 1),
      }),
    ).toThrow();
  }
  expect(() => encodePostingChunk([3, 3])).toThrow();
  expect(() => encodePostingChunk([3, 2])).toThrow();
  expect(() => encodePostingChunk([2 ** 32])).toThrow();
  expect(() =>
    decodePostingChunk({ first: 0, count: 1, data: new Uint8Array([2]) }),
  ).toThrow();
});

test("posting batches preserve membership across flushes and colliding name/context terms", async () => {
  const { PostingSpool, decodePostingChunk } = await import(
    "../packages/geocoding/src/posting-spool"
  );
  const db = new Database(":memory:");
  try {
    const postings = new PostingSpool(db);
    const count = 5000;
    for (let i = 0; i < count; i++)
      postings.add(
        {
          id: String(i),
          name: "Station n:a alphabet",
          aliases: ["Alphabet station"],
          context: "A named area with common repeated context and many words",
          coordinates: [6.8, 51.2],
          kind: "poi",
          category: "station",
        },
        i,
      );
    postings.flush();
    const rows = db
      .query<
        import("../packages/geocoding/src/posting-spool").PostingChunk,
        []
      >("SELECT first,count,data FROM postings WHERE term='n:a' ORDER BY first")
      .all();
    expect(rows.length).toBeGreaterThan(1);
    const ids = rows.flatMap((row: any) => [...decodePostingChunk(row)]);
    expect(ids).toEqual(Array.from({ length: count }, (_, i) => i));
    const sum = db.query("SELECT sum(count) AS n FROM postings").get() as {
      n: number;
    };
    expect(sum.n).toBe(postings.count);
    expect(() =>
      postings.add(
        {
          id: "bad",
          name: "out of order",
          category: "station",
          aliases: [],
          coordinates: [0, 0],
          kind: "poi",
        },
        0,
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});
