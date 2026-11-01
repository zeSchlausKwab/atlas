import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import type { Manifest } from "../packages/format/src/index";
const m: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "stream fixture",
  source: { url: "test", sha256: "0".repeat(64), attribution: "test" },
  bounds: [-180, -85, 180, 85],
  minZoom: 6,
  maxZoom: 6,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  limitations: [],
  tileLayers: ["water"],
};
test("disk directory preserves all blocks across multiple leaves and rejects duplicates", async () => {
  const dir = await mkdtemp("/tmp/atlas-writer-");
  const writer = await new StreamWriter(
    dir + "/map.atlas",
    10 * 1024 ** 2,
  ).open();
  try {
    const bytes = new Uint8Array(8);
    bytes.set(new TextEncoder().encode("TIL2"));
    for (let x = 0; x < 64; x++)
      await writer.add({ key: `tile/water/6/${x}/1`, bytes });
    await expect(
      writer.add({ key: "tile/water/6/0/1", bytes }),
    ).rejects.toThrow();
    const progress: { stage: string; done: number; total: number }[] = [];
    await writer.finish(m, undefined, (stage, done, total) =>
      progress.push({ stage, done, total }),
    );
    expect(
      progress.filter((p) => p.stage === "directory").map((p) => p.done),
    ).toEqual([0, 1, 2]);
    const payload = progress.filter((p) => p.stage === "payload");
    expect(payload[0]!.done).toBe(0);
    expect(payload.at(-1)!.done).toBe(payload.at(-1)!.total);
    expect(payload.at(-1)!.total).toBeGreaterThan(512);
    const r = await new AtlasReader(
      new FileSource(Bun.file(dir + "/map.atlas")),
    ).open();
    expect(r.index.pages.length).toBe(2);
    expect((await r.allBlocks()).length).toBe(64);
    expect(await r.block("tile/water/6/63/1")).toEqual(bytes);
    r.dispose();
  } finally {
    await writer.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-place archive compaction preserves payload across overlapping chunks and failed replacement", async () => {
  const { randomFillSync } = await import("node:crypto");
  const dir = await mkdtemp("/tmp/atlas-writer-large-");
  const path = dir + "/map.atlas";
  const writer = await new StreamWriter(path, 100 * 1024 ** 2).open();
  const hashes: string[] = [];
  try {
    // More than the reserved 64 MiB prefix, and multiple 4 MiB copy chunks.
    for (let x = 0; x < 9; x++) {
      const bytes = randomFillSync(new Uint8Array(8 * 1024 ** 2));
      hashes.push(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
      await writer.add({ key: `tile/water/6/${x}/1`, bytes });
    }
    await writer.finish(m);
    const reader = await new AtlasReader(new FileSource(Bun.file(path))).open();
    for (let x = 0; x < 9; x++)
      expect(
        new Bun.CryptoHasher("sha256")
          .update(await reader.block(`tile/water/6/${x}/1`))
          .digest("hex"),
      ).toBe(hashes[x]);
    const snapshot = reader.index.manifest.snapshot;
    reader.dispose();
    const replacement = await new StreamWriter(path, 1).open();
    await expect(
      replacement.add({ key: "query/test", bytes: new Uint8Array(100) }),
    ).rejects.toThrow("budget");
    await replacement.abort();
    const old = await new AtlasReader(new FileSource(Bun.file(path))).open();
    expect(old.index.manifest.snapshot).toBe(snapshot);
    old.dispose();
  } finally {
    await writer.abort();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("archive payloads and SQLite directory can use separate disks", async () => {
  const { mkdir } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/atlas-writer-split-");
  await mkdir(dir + "/ssd");
  await mkdir(dir + "/nas");
  const output = dir + "/nas/map.atlas",
    db = dir + "/ssd/directory.sqlite";
  const writer = await new StreamWriter(output, 1024 ** 2, db).open();
  try {
    const bytes = new TextEncoder().encode("query fixture");
    await writer.add({ key: "query/test", bytes });
    expect(await Bun.file(db).exists()).toBe(true);
    expect(await Bun.file(output + ".directory.part").exists()).toBe(false);
    expect(await Bun.file(output + ".payload.part").exists()).toBe(true);
    await writer.finish(m);
    const reader = await new AtlasReader(
      new FileSource(Bun.file(output)),
    ).open();
    expect(await reader.block("query/test")).toEqual(bytes);
    reader.dispose();
    expect(await Bun.file(db).exists()).toBe(false);
    const aborted = await new StreamWriter(
      output + ".new",
      1024 ** 2,
      db,
    ).open();
    await aborted.abort();
    expect(await Bun.file(db).exists()).toBe(false);
    expect(await Bun.file(output + ".new.payload.part").exists()).toBe(false);
  } finally {
    await writer.abort();
    await rm(dir, { recursive: true, force: true });
  }
});
