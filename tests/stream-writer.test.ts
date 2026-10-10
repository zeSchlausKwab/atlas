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
    await writer.finish(m);
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
