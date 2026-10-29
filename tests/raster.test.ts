import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { packRaster } from "../packages/raster/src/pack";
import {
  AtlasReader,
  FileSource,
  purposeOf,
} from "../packages/format/src/reader";
import {
  validateRasters,
  pngTile,
  type RasterLayer,
} from "../packages/format/src/raster";
import { composeCapabilities } from "../packages/provisioning/src/compose-capabilities";
import { installedCapabilities } from "../packages/provisioning/src/families";
function png() {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (s: string, d: Buffer) => {
    const type = Buffer.from(s),
      b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length);
    type.copy(b, 4);
    d.copy(b, 8);
    b.writeUInt32BE(crc(Buffer.concat([type, d])), 8 + d.length);
    return b;
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(256);
  h.writeUInt32BE(256, 4);
  h[8] = 8;
  h[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", h),
    chunk("IDAT", deflateSync(Buffer.alloc(256 * (256 * 4 + 1)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const descriptor: RasterLayer = {
  id: "test",
  name: "Test imagery",
  version: 1,
  kind: "imagery",
  crs: "EPSG:3857",
  matrix: "xyz",
  encoding: "png",
  tileSize: 256,
  minZoom: 0,
  maxZoom: 0,
  bounds: [-180, -85, 180, 85],
  source: {
    url: "https://example.test/tiles",
    license: "test fixture",
    attribution: "Atlas tests",
  },
};
test("raster descriptors and PNG headers reject unsupported projections and mismatched dimensions", () => {
  expect(() => validateRasters([descriptor])).not.toThrow();
  for (const patch of [
    { crs: "EPSG:4326" },
    { id: "../bad" },
    { tileSize: 8192 },
    { maxZoom: 30 },
    { bounds: [0, 0, 0, 2] },
  ])
    expect(() => validateRasters([{ ...descriptor, ...patch }])).toThrow();
  expect(() => pngTile(png(), 256)).not.toThrow();
  expect(() => pngTile(png(), 512)).toThrow();
  expect(() => pngTile(new Uint8Array(50), 256)).toThrow();
});
test("raster archive uses paged range reads, shares map accounting, and remains standalone and immutable", async () => {
  const dir = await mkdtemp("/tmp/atlas-raster-");
  let r: AtlasReader | undefined;
  try {
    const tile = png();
    await Bun.write(dir + "/xyz/0/0/0.png", tile);
    const result = await packRaster(
      dir + "/xyz",
      descriptor,
      dir + "/one.atlas",
    );
    expect(result.tiles).toBe(1);
    r = await new AtlasReader(
      new FileSource(Bun.file(dir + "/one.atlas")),
    ).open();
    expect(r.index.manifest.rasters).toEqual([descriptor]);
    expect(r.index.pages[0]!.prefix).toBe("raster/test");
    const reads = r.bytesRead;
    expect(await r.block("raster/test/0/0/0")).toEqual(new Uint8Array(tile));
    expect(r.bytesRead).toBeGreaterThan(reads);
    expect(purposeOf("raster/test/0/0/0")).toBe("map");
    const read = r.bytesRead;
    r.offline = true;
    expect(await r.block("raster/test/0/0/0")).toEqual(new Uint8Array(tile));
    expect(r.bytesRead).toBe(read);
    await expect(
      packRaster(dir + "/xyz", descriptor, dir + "/one.atlas"),
    ).rejects.toThrow("exists");
    expect(installedCapabilities(r.index.manifest)).toEqual(["raster:test"]);
    await composeCapabilities(
      r,
      undefined,
      {
        targetId: "test",
        targetSnapshot: r.index.manifest.snapshot,
        name: "Retained raster",
        capabilities: ["raster:test"],
        paddingCells: 0,
        maxBytes: 1024 ** 2,
      },
      [],
      dir + "/copy.atlas",
      new AbortController().signal,
    );
    const copy = await new AtlasReader(
      new FileSource(Bun.file(dir + "/copy.atlas")),
    ).open();
    expect(copy.index.manifest.rasters).toEqual([descriptor]);
    expect(await copy.block("raster/test/0/0/0")).toEqual(new Uint8Array(tile));
    copy.dispose();
  } finally {
    r?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
