import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { FeatureCollection, Polygon } from "geojson";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import {
  project,
  TILE_EXTENT,
  type Manifest,
} from "../packages/format/src/index";
import { tileRecords } from "../packages/format/src/tiles";
import { oceanTiles } from "../packages/cli/src/ocean-tiles";
import { WaterPatchWriter } from "../packages/cli/src/water-patch";
import { encodeTile } from "../packages/cli/src/tile-codec";
import type geojsonvt from "geojson-vt";
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Ocean fixture",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "OSM" },
  bounds: [-20, -20, 20, 20],
  minZoom: 0,
  maxZoom: 6,
  features: 1,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  limitations: [],
  tileLayers: ["water", "roads"],
};
const ocean = (): FeatureCollection<Polygon> => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-20, -20],
            [20, -20],
            [20, 20],
            [-20, 20],
            [-20, -20],
          ],
          [
            [-5, -5],
            [-5, 5],
            [5, 5],
            [5, -5],
            [-5, -5],
          ],
        ],
      },
    },
  ],
});
export function coversWater(
  bytes: Uint8Array,
  lon: number,
  lat: number,
  z: number,
  x: number,
  y: number,
) {
  const [wx, wy] = project(lon, lat),
    px = (wx * 2 ** z - x) * TILE_EXTENT,
    py = (wy * 2 ** z - y) * TILE_EXTENT;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const r of tileRecords(bytes)) {
    if (r.class !== 1 || r.kind !== 3) continue;
    let at = r.geometryOffset,
      inside = false;
    for (let p = 0; p < r.parts; p++) {
      const n = v.getUint32(at, true);
      at += 4;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = v.getUint16(at + i * 4, true),
          ay = v.getUint16(at + i * 4 + 2, true);
        const bx = v.getUint16(at + j * 4, true),
          by = v.getUint16(at + j * 4 + 2, true);
        if (
          ay > py !== by > py &&
          px < ((bx - ax) * (py - ay)) / (by - ay) + ax
        )
          inside = !inside;
      }
      at += n * 4;
    }
    if (inside) return true;
  }
  return false;
}
test("assembled ocean fills sea, preserves island holes and is clipped at every zoom", async () => {
  const blocks = new Map<string, Uint8Array>();
  await oceanTiles(
    ocean(),
    manifest,
    new AbortController().signal,
    async (b) => {
      blocks.set(b.key, b.bytes);
    },
  );
  for (let z = 0; z <= 6; z++)
    for (const [lon, lat, expected] of [
      [10, 10, true],
      [1, 1, false],
      [30, 10, false],
    ] as const) {
      const [x, y] = project(lon, lat).map((v) => Math.floor(v * 2 ** z));
      const tile = blocks.get(`tile/water/${z}/${x}/${y}`);
      expect(tile ? coversWater(tile, lon, lat, z, x!, y!) : false).toBe(
        expected,
      );
    }
  await expect(
    oceanTiles(
      ocean(),
      { ...manifest, bounds: [-10, -10, 10, 10] },
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow("Clip ocean");
});

test("water-only patch merges inland water and preserves other payloads and directory hashes", async () => {
  const dir = await mkdtemp("/tmp/atlas-ocean-");
  const bytes = encodeTile([
    {
      type: 3,
      tags: { class: 1 },
      geometry: [
        [
          [100, 100],
          [200, 100],
          [200, 200],
          [100, 200],
          [100, 100],
        ],
      ],
    } as unknown as geojsonvt.Feature,
  ]);
  const inputs: InputBlock[] = [
    { key: "tile/water/0/0/0", z: 0, x: 0, y: 0, bytes, features: 1 },
    {
      key: "tile/roads/6/30/30",
      z: 6,
      x: 30,
      y: 30,
      bytes: new Uint8Array([1, 2, 3]),
    },
    {
      key: "search/locations",
      bytes: new TextEncoder().encode("search must be unchanged"),
    },
  ];
  const original = await encodePackage(manifest, inputs, { paged: true });
  await Bun.write(dir + "/old.atlas", original);
  const reader = await new AtlasReader(
    new FileSource(Bun.file(dir + "/old.atlas")),
  ).open();
  const writer = new WaterPatchWriter(
    reader,
    dir + "/new.atlas",
    256 * 1024 ** 2,
    new AbortController().signal,
  );
  try {
    await writer.open();
    await oceanTiles(ocean(), manifest, new AbortController().signal, (b) =>
      writer.add(b),
    );
    await writer.finish(manifest);
    const patched = await new AtlasReader(
      new FileSource(Bun.file(dir + "/new.atlas")),
    ).open();
    expect(patched.index.manifest.snapshot).not.toBe(
      reader.index.manifest.snapshot,
    );
    expect(
      patched.index.pages.find((p) => p.prefix === "tile/roads")!.hash,
    ).toBe(reader.index.pages.find((p) => p.prefix === "tile/roads")!.hash);
    for (const b of inputs.slice(1))
      expect(await patched.block(b.key)).toEqual(b.bytes);
    const water = await patched.block("tile/water/0/0/0");
    const records = [...tileRecords(water)];
    expect(records.length).toBe(2);
    const last = records.at(-1)!;
    expect(water.subarray(last.start, last.end)).toEqual(bytes.subarray(8));
    expect((await patched.tiles(6, 33, 33, 30, 30, ["water"])).length).toBe(1);
    const before = patched.bytesRead;
    expect(await patched.tiles(6, 33, 33, 30, 30, ["roads"])).toEqual([]);
    expect(patched.bytesRead).toBe(before);
    expect(await Bun.file(dir + "/old.atlas").bytes()).toEqual(original);
    patched.dispose();
  } finally {
    await writer.abort();
    reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancel and output-budget failure leave original and unrelated partial files intact", async () => {
  const dir = await mkdtemp("/tmp/atlas-ocean-abort-");
  const original = await encodePackage(manifest, [], { paged: true });
  await Bun.write(dir + "/old.atlas", original);
  const reader = await new AtlasReader(
    new FileSource(Bun.file(dir + "/old.atlas")),
  ).open();
  try {
    await Bun.write(dir + "/existing.atlas.part", "saved work");
    const collision = new WaterPatchWriter(
      reader,
      dir + "/existing.atlas",
      1e9,
      new AbortController().signal,
    );
    await expect(collision.open()).rejects.toThrow();
    await collision.abort();
    expect(await Bun.file(dir + "/existing.atlas.part").text()).toBe(
      "saved work",
    );
    const small = new WaterPatchWriter(
      reader,
      dir + "/small.atlas",
      100,
      new AbortController().signal,
    );
    await expect(small.open()).rejects.toThrow("budget");
    await small.abort();
    const controller = new AbortController();
    const cancelled = new WaterPatchWriter(
      reader,
      dir + "/cancelled.atlas",
      1e9,
      controller.signal,
    );
    await cancelled.open();
    controller.abort();
    await expect(
      oceanTiles(ocean(), manifest, controller.signal, (b) => cancelled.add(b)),
    ).rejects.toThrow();
    await cancelled.abort();
    expect(await Bun.file(dir + "/cancelled.atlas").exists()).toBe(false);
    expect(await Bun.file(dir + "/cancelled.atlas.part").exists()).toBe(false);
    expect(await Bun.file(dir + "/old.atlas").bytes()).toEqual(original);
  } finally {
    reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
