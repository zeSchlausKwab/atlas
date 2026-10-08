import { expect, test } from "bun:test";
import { encodePackage } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import type { Manifest } from "../packages/format/src/index";
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Paged fixture",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [0, 0, 90, 60],
  minZoom: 8,
  maxZoom: 8,
  features: 4096,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  limitations: [],
};
const inputs = Array.from({ length: 4096 }, (_, i) => ({
  key: `tile/8/${128 + (i % 64)}/${64 + Math.floor(i / 64)}`,
  z: 8,
  x: 128 + (i % 64),
  y: 64 + Math.floor(i / 64),
  features: 1,
  bytes: new Uint8Array([i % 256, Math.floor(i / 256)]),
}));
async function fixture() {
  return encodePackage(manifest, inputs, { paged: true });
}
test("map open reads a small root; a viewport reads only its directory page", async () => {
  const bytes = await fixture();
  const reads: string[] = [];
  const r = await new AtlasReader(new FileSource(new Blob([bytes])), (e) => {
    if (!e.cached) reads.push(e.key);
  }).open();
  expect(r.bytesRead).toBeLessThan(10_000);
  expect(r.index.tileCount).toBe(4096);
  expect(r.index.blocks.length).toBe(0);
  const blocks = await r.tiles(8, 128, 129, 64, 65);
  expect(blocks).toHaveLength(4);
  expect(reads.filter((k) => k.startsWith("index/"))).toHaveLength(1);
  expect(reads.some((k) => k.startsWith("tile/"))).toBe(false);
  expect(await r.block("tile/8/128/64")).toEqual(inputs[0]!.bytes);
  const n = r.requests;
  r.offline = true;
  expect(await r.tiles(8, 128, 129, 64, 65)).toHaveLength(4);
  expect(r.requests).toBe(n);
  await expect(r.tiles(8, 180, 181, 100, 101)).rejects.toThrow("Not cached");
});
test("concurrent page queries deduplicate; absent tiles and corrupt pages are explicit", async () => {
  const bytes = await fixture();
  const r = await new AtlasReader(new FileSource(new Blob([bytes]))).open();
  await Promise.all([r.tiles(8, 128, 130, 64, 66), r.block("tile/8/128/64")]);
  expect(r.requests).toBe(4);
  expect(await r.tiles(8, 0, 2, 0, 2)).toEqual([]);
  await expect(r.block("tile/8/0/0")).rejects.toThrow("not present");
  const bad = bytes.slice();
  const p = r.index.pages[0]!;
  bad[r.index.header.payloadOffset + p.offset + 5] ^= 1;
  const broken = await new AtlasReader(new FileSource(new Blob([bad]))).open();
  await expect(broken.tiles(8, 128, 128, 64, 64)).rejects.toThrow("Integrity");
});
test("a complete catalog is an explicit operation and legacy files remain readable", async () => {
  const r = await new AtlasReader(
    new FileSource(new Blob([await fixture()])),
  ).open();
  expect(await r.allBlocks()).toHaveLength(4096);
  const legacy = await new AtlasReader(
    new FileSource(new Blob([await encodePackage(manifest, inputs)])),
  ).open();
  expect(legacy.index.tileCount).toBe(4096);
  expect(await legacy.tiles(8, 128, 128, 64, 64)).toHaveLength(1);
});
test("a map-only reader refuses unrelated payloads before reading them", async () => {
  const bytes = await encodePackage(
    manifest,
    [
      ...inputs.slice(0, 1),
      { key: "query/peaks", bytes: new TextEncoder().encode("[]") },
    ],
    { paged: true },
  );
  const r = await new AtlasReader(
    new FileSource(new Blob([bytes])),
    undefined,
    { purposes: ["map", "labels"] },
  ).open();
  const before = r.requests;
  await expect(r.highestPeak()).rejects.toThrow("not enabled");
  expect(r.requests).toBe(before);
  await r.block(inputs[0]!.key);
  expect(r.bytesByPurpose.map).toBe(2);
  expect(r.bytesByPurpose.queries).toBe(0);
});
