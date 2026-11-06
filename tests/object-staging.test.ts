import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectWriter } from "../packages/objects/src/build";

test("source object staging does not duplicate raw geometry and relationships on the SSD", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-object-staging-"));
  const path = join(dir, "index.sqlite");
  let streamed = 0;
  const writer = new ObjectWriter(
    {
      add: async (b) => {
        streamed += b.bytes.length;
      },
    },
    path,
  );
  try {
    const coordinates = Array.from({ length: 20000 }, (_, i) => [
      16 + i / 1e6,
      48 + i / 1e6,
    ]);
    const nodeRefs = coordinates.map((_, i) => String(i));
    for (let i = 0; i < 40; i++)
      await writer.add({
        id: `way/${i}`,
        tags: { highway: "residential", name: "Test street" },
        geometry: { type: "LineString", coordinates },
        geometryStatus: "complete",
        nodeRefs,
      });
    expect(streamed).toBeGreaterThan(10 * 1024 ** 2);
    expect((await stat(path)).size).toBeLessThan(2 * 1024 ** 2);
  } finally {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import { Database } from "bun:sqlite";
import { ObjectStaging } from "../packages/objects/src/staging";
import { writeSourceObjects } from "../packages/objects/src/source-build";
import { compilerProgress } from "../packages/provisioning/src/compiler-progress";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  findObject,
  objectCatalog,
  objectRecords,
  objectGeometry,
  objectTopology,
} from "../packages/objects/src/index";

const manifest = {
  format: "atlas" as const,
  version: 1 as const,
  name: "Resume",
  source: { url: "fixture", sha256: "a".repeat(64), attribution: "Synthetic" },
  bounds: [16, 48, 17, 49] as [number, number, number, number],
  minZoom: 0,
  maxZoom: 16,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: ["source-objects", "feature-extraction"],
  featureZoom: 12,
  featureKinds: ["objects" as const],
  limitations: [],
};
async function readerFor(store: ObjectStaging) {
  const blocks: InputBlock[] = [];
  await store.copyTo({
    add: async (b) => {
      blocks.push(b);
    },
  });
  return new AtlasReader(
    new FileSource(
      new Blob([await encodePackage(manifest, blocks, { paged: true })]),
    ),
  ).open();
}
for (const stopStage of [
  "semantic-object-ingest",
  "semantic-object-packing",
  "semantic-object-lookup",
  "semantic-object-tags",
]) {
  test(`source objects recover committed ${stopStage} batches with exact geometry, tags and identities`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-objects-resume-"));
    const db = new Database(join(dir, "source.sqlite"));
    db.run(
      "CREATE TABLE source_objects(id TEXT PRIMARY KEY,data BLOB,cell INTEGER,bbox TEXT); CREATE INDEX source_object_cells ON source_objects(cell); CREATE TABLE metadata(key TEXT PRIMARY KEY,json TEXT); INSERT INTO metadata VALUES('stats','{\"coordinates\":40000}')",
    );
    db.transaction(() => {
      for (let i = 0; i < 10250; i++) {
        const v = {
          id: `node/${i}`,
          tags: { amenity: "bench", name: `Bench ${i}` },
          geometry: { type: "Point", coordinates: [16 + (i % 10) / 100, 48] },
          geometryStatus: "complete",
          members: [{ id: `way/${i}`, role: "entrée" }],
        };
        db.query("INSERT INTO source_objects VALUES(?,?,?,NULL)").run(
          v.id,
          Bun.gzipSync(JSON.stringify(v)),
          i % 10,
        );
      }
    })();
    const index = join(dir, "stage.sqlite"),
      payload = join(dir, "workspace.payload");
    let store = await new ObjectStaging(index, payload, "fixture").open();
    try {
      const stop = new AbortController();
      await expect(
        writeSourceObjects(
          db,
          store,
          undefined,
          stop.signal,
          (line) => {
            const p = compilerProgress(line);
            if (p?.stage === stopStage && p.checkpointAt && p.completed! > 0)
              stop.abort();
          },
          [],
          store,
        ),
      ).rejects.toThrow();
      const saved = store.state;
      expect(saved).toBeDefined();
      const bytes = store.payloadBytes;
      // Add a real uncommitted block: reopening must remove its DB entry and payload tail.
      await store.add({
        key: "test/uncommitted",
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      await store.close();
      store = await new ObjectStaging(index, payload, "fixture").open();
      expect(store.payloadBytes).toBe(bytes);
      expect((await stat(payload)).size).toBe(bytes);
      expect(
        store.db
          .query("SELECT key FROM stage_blocks WHERE key='test/uncommitted'")
          .get(),
      ).toBeNull();
      const progress: any[] = [];
      await writeSourceObjects(
        db,
        store,
        undefined,
        undefined,
        (line) => progress.push(compilerProgress(line)),
        [],
        store,
      );
      expect(store.state.phase).toBe("done");
      const reader = await readerFor(store);
      try {
        expect((await objectCatalog(reader)).count).toBe(10250);
        expect((await objectCatalog(reader)).report.counts).toEqual({
          node: 10250,
        });
        const ids = new Set<string>();
        for await (const row of objectRecords(reader, {
          tag: { key: "amenity", value: "bench" },
        }))
          ids.add(row.id);
        expect(ids.size).toBe(10250);
        for (const i of [0, 9999, 10249]) {
          const row = (await findObject(reader, `node/${i}`))!;
          expect(row.tags.name).toBe(`Bench ${i}`);
          expect(await objectGeometry(reader, row)).toEqual({
            type: "Point",
            coordinates: [16 + (i % 10) / 100, 48],
          });
          expect((await objectTopology(reader, row)).members).toEqual([
            { id: `way/${i}`, role: "entrée" },
          ]);
        }
      } finally {
        reader.dispose();
      }
      // Fully finished stage can be replayed without adding duplicate blocks.
      const n = store.db
        .query<{ n: number }, []>("SELECT count(*) n FROM stage_blocks")
        .get()!.n;
      await writeSourceObjects(
        db,
        store,
        undefined,
        undefined,
        () => {},
        [],
        store,
      );
      expect(
        store.db
          .query<{ n: number }, []>("SELECT count(*) n FROM stage_blocks")
          .get()!.n,
      ).toBe(n);
    } finally {
      await store.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
}

test("source checkpoint rejects another recipe, truncated payload and modified blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-checkpoint-"));
  const index = join(dir, "stage.sqlite"),
    payload = join(dir, "payload");
  let store = await new ObjectStaging(index, payload, "a").open();
  try {
    await store.add({ key: "test/1", bytes: new Uint8Array([1, 2, 3]) });
    await store.checkpoint({});
    await store.close();
    await expect(new ObjectStaging(index, payload, "b").open()).rejects.toThrow(
      "identity mismatch",
    );
    await Bun.write(payload, new Uint8Array([1, 3, 3]));
    store = await new ObjectStaging(index, payload, "a").open();
    await expect(store.copyTo({ add: async () => {} })).rejects.toThrow(
      "checksum mismatch",
    );
    await store.close();
    await Bun.write(payload, new Uint8Array());
    await expect(new ObjectStaging(index, payload, "a").open()).rejects.toThrow(
      "truncated",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL recovers the hot journal and discards an uncommitted payload tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-kill-checkpoint-"));
  const index = join(dir, "stage.sqlite"),
    payload = join(dir, "payload");
  try {
    const script = `import {ObjectStaging} from ${JSON.stringify(new URL("../packages/objects/src/staging.ts", import.meta.url).pathname)};
      const s=await new ObjectStaging(${JSON.stringify(index)},${JSON.stringify(payload)},'kill').open();
      await s.add({key:'kept',bytes:new Uint8Array([1,2,3])});await s.checkpoint({phase:'kept'});
      s.db.run('PRAGMA cache_size=10');
      for(let i=0;i<1000;i++) await s.add({key:'discarded/'+i,bytes:new Uint8Array(10000)});
      process.kill(process.pid,'SIGKILL');`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const store = await new ObjectStaging(index, payload, "kill").open();
    try {
      expect(store.state).toEqual({ phase: "kept" });
      expect((await stat(payload)).size).toBe(3);
      const keys: string[] = [];
      await store.copyTo({
        add: async (b) => {
          keys.push(b.key);
        },
      });
      expect(keys).toEqual(["kept"]);
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
