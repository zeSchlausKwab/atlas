import { test, expect } from "bun:test";
import { mkdtemp, rm, open } from "node:fs/promises";
import { copyArchiveBlocks } from "../packages/cli/src/archive-copy";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import type { Manifest } from "../packages/format/src/index";
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Assembly fixture",
  source: { url: "test", sha256: "0".repeat(64), attribution: "test" },
  bounds: [-180, -85, 180, 85],
  minZoom: 0,
  maxZoom: 0,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: [],
  limitations: [],
};
test("assembly preserves compressed and raw payloads and bounds file operations", async () => {
  const dir = await mkdtemp("/tmp/atlas-copy-");
  const source = await new StreamWriter(
    dir + "/source.atlas",
    32 * 1024 ** 2,
  ).open();
  const target = await new StreamWriter(
    dir + "/copy.atlas",
    32 * 1024 ** 2,
  ).open();
  const data = new TextEncoder().encode("same stored bytes ".repeat(512));
  try {
    for (let i = 0; i < 1024; i++)
      await source.add(
        { key: `query/${i}`, bytes: data },
        { compress: i % 2 === 0 },
      );
    await source.finish(manifest);
    const result = await copyArchiveBlocks(
      dir + "/source.atlas",
      target,
      new AbortController().signal,
    );
    await target.finish(manifest);
    expect(result.blocks).toBe(1024);
    expect(result.readCalls).toBeLessThan(32);
    expect(result.readBytes).toBeLessThan(
      Bun.file(dir + "/source.atlas").size * 1.2,
    );
    const before = await new AtlasReader(
      new FileSource(Bun.file(dir + "/source.atlas")),
    ).open();
    const after = await new AtlasReader(
      new FileSource(Bun.file(dir + "/copy.atlas")),
    ).open();
    try {
      expect(await after.allBlocks()).toEqual(await before.allBlocks());
      expect(after.index.manifest.snapshot).toBe(
        before.index.manifest.snapshot,
      );
      expect(await after.block("query/0")).toEqual(data);
      expect(await after.block("query/1")).toEqual(data);
    } finally {
      before.dispose();
      after.dispose();
    }
  } finally {
    await source.abort();
    await target.abort();
    await rm(dir, { recursive: true, force: true });
  }
});
test("assembly rejects corrupt data and cancellation without publishing a replacement", async () => {
  const dir = await mkdtemp("/tmp/atlas-copy-corrupt-");
  const source = await new StreamWriter(
    dir + "/source.atlas",
    1024 ** 2,
  ).open();
  const target = await new StreamWriter(dir + "/copy.atlas", 1024 ** 2).open();
  try {
    await source.add({
      key: "query/value",
      bytes: new TextEncoder().encode("valid".repeat(100)),
    });
    await source.finish(manifest);
    const r = await new AtlasReader(
      new FileSource(Bun.file(dir + "/source.atlas")),
    ).open();
    const at = r.index.header.payloadOffset + r.index.blocks[0]!.offset;
    r.dispose();
    const f = await open(dir + "/source.atlas", "r+");
    await f.write(new Uint8Array([0]), 0, 1, at);
    await f.close();
    await expect(
      copyArchiveBlocks(
        dir + "/source.atlas",
        target,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Integrity");
    expect(target.blockCount).toBe(0);
    expect(await Bun.file(dir + "/copy.atlas").exists()).toBe(false);
    const abort = new AbortController();
    abort.abort();
    await expect(
      copyArchiveBlocks(dir + "/source.atlas", target, abort.signal),
    ).rejects.toThrow();
  } finally {
    await source.abort();
    await target.abort();
    await rm(dir, { recursive: true, force: true });
  }
});
