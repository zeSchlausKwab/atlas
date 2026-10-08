import { expect, test } from "bun:test";
import {
  MAP_LAYERS,
  layerForClass,
  type Manifest,
} from "../packages/format/src/index";
import { splitTile } from "../packages/format/src/tiles";
import { encodePackage } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { splitPackageLayers } from "../packages/cli/src/split-layers";
import { extract } from "../packages/offline/src/index";
import { mkdtemp, rm } from "node:fs/promises";
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "All layers",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [0, 0, 20, 20],
  minZoom: 0,
  maxZoom: 0,
  features: 8,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  limitations: [],
};
function tile() {
  const records = Array.from({ length: 8 }, (_, cls) => {
    // Two closed polygon rings, including a courtyard, retain their exact bytes.
    const rings =
      cls === 2
        ? [
            [
              [1, 1],
              [1, 50],
              [50, 50],
              [50, 1],
              [1, 1],
            ],
            [
              [10, 10],
              [20, 10],
              [20, 20],
              [10, 20],
              [10, 10],
            ],
          ]
        : [
            [
              [cls, cls],
              [30, 30],
            ],
          ];
    const b = new Uint8Array(
        4 + rings.reduce((n, r) => n + 4 + r.length * 4, 0),
      ),
      v = new DataView(b.buffer);
    v.setUint8(0, cls);
    v.setUint8(1, cls === 2 ? 3 : 2);
    v.setUint16(2, rings.length, true);
    let o = 4;
    for (const r of rings) {
      v.setUint32(o, r.length, true);
      o += 4;
      for (const [x, y] of r) {
        v.setUint16(o, x!, true);
        v.setUint16(o + 2, y!, true);
        o += 4;
      }
    }
    return b;
  });
  const bytes = new Uint8Array(8 + records.reduce((n, r) => n + r.length, 0));
  bytes.set(new TextEncoder().encode("TIL1"));
  new DataView(bytes.buffer).setUint32(4, records.length, true);
  let o = 8;
  for (const r of records) {
    bytes.set(r, o);
    o += r.length;
  }
  return { bytes, records };
}
async function fixture(reads: string[] = []) {
  const { bytes } = tile();
  const inputs = splitTile(bytes).map((p) => ({
    key: `tile/${p.layer}/0/0/0`,
    z: 0,
    x: 0,
    y: 0,
    features: p.features,
    bytes: p.bytes,
  }));
  const pkg = await encodePackage(
    { ...manifest, tileLayers: [...MAP_LAYERS] },
    inputs,
    { paged: true },
  );
  return new AtlasReader(new FileSource(new Blob([pkg])), (e) => {
    if (!e.cached) reads.push(e.key);
  }).open();
}
test("tile splitting preserves every byte of geometry, including building holes", () => {
  const { bytes, records } = tile(),
    parts = splitTile(bytes);
  expect(parts.map((p) => p.layer)).toEqual([...MAP_LAYERS]);
  for (const part of parts) {
    const expected = records.filter((_, i) => layerForClass(i) === part.layer);
    expect(part.features).toBe(expected.length);
    expect(part.bytes.slice(8)).toEqual(
      new Uint8Array(expected.flatMap((b) => [...b])),
    );
  }
  expect(() => splitTile(bytes.slice(0, -1))).toThrow();
  const bad = bytes.slice();
  bad[8] = 255;
  expect(() => splitTile(bad)).toThrow();
  expect(() => splitTile(new Uint8Array([...bytes, 0]))).toThrow();
});
test("arbitrary layer combinations fetch only matching pages and payloads, even after other layers were cached", async () => {
  const reads: string[] = [],
    r = await fixture(reads);
  expect(reads).toEqual(["header", "index"]);
  for (const b of await r.tiles(0, 0, 0, 0, 0, ["buildings", "water"]))
    await r.block(b.key);
  expect(reads.slice(2).sort()).toEqual(
    [
      "index/tile/buildings/0/0/0",
      "index/tile/water/0/0/0",
      "tile/buildings/0/0/0",
      "tile/water/0/0/0",
    ].sort(),
  );
  expect(r.bytesByLayer.buildings).toBeGreaterThan(0);
  expect(r.bytesByLayer.water).toBeGreaterThan(0);
  expect(r.bytesByLayer.roads).toBe(0);
  let before = r.requests;
  r.offline = true;
  for (const b of await r.tiles(0, 0, 0, 0, 0, ["water"])) await r.block(b.key);
  expect(r.requests).toBe(before);
  expect(await r.tiles(0, 0, 0, 0, 0, [])).toEqual([]);
  await expect(r.tiles(0, 0, 0, 0, 0, ["roads"])).rejects.toThrow("Not cached");
  r.offline = false;
  for (const b of await r.tiles(0, 0, 0, 0, 0, ["roads"])) await r.block(b.key);
  expect(
    (await r.tiles(0, 0, 0, 0, 0, ["buildings", "water"]))
      .map((b) => b.key)
      .sort(),
  ).toEqual(["tile/buildings/0/0/0", "tile/water/0/0/0"]);
  expect(r.index.tileCount).toBe(6);
});
test("offline exports preserve the chosen layer subset without reading excluded layers", async () => {
  const reads: string[] = [],
    r = await fixture(reads);
  const blob = await extract(r, {
    polygon: [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ],
    name: "Water and buildings",
    minZoom: 0,
    maxZoom: 0,
    layers: ["water", "buildings"],
    streetNames: false,
    pois: false,
    routing: false,
    search: false,
  });
  const child = await new AtlasReader(new FileSource(blob)).open();
  expect(child.index.manifest.tileLayers).toEqual(["water", "buildings"]);
  expect((await child.allBlocks()).map((b) => b.key).sort()).toEqual([
    "tile/buildings/0/0/0",
    "tile/water/0/0/0",
  ]);
  expect(reads.some((k) => k.includes("/roads/"))).toBe(false);
  await expect(
    extract(r, {
      polygon: [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
      ],
      name: "Bad",
      minZoom: 0,
      maxZoom: 0,
      layers: ["unknown" as any],
      routing: false,
      search: false,
    }),
  ).rejects.toThrow("Invalid selected");
});
test("existing packages migrate atomically, retain non-map payload hashes and remain legacy-readable", async () => {
  const dir = await mkdtemp("/tmp/atlas-layers-");
  try {
    const input = `${dir}/input.atlas`,
      output = `${dir}/output.atlas`,
      { bytes } = tile(),
      raw = new TextEncoder().encode("retained metadata ".repeat(500));
    await Bun.write(
      input,
      await encodePackage(
        manifest,
        [
          { key: "tile/0/0/0", z: 0, x: 0, y: 0, features: 8, bytes },
          {
            key: "source/test",
            bytes: Bun.gzipSync(raw),
            codec: "gzip",
            rawLength: raw.length,
          },
        ],
        { paged: true },
      ),
    );
    const legacy = await new AtlasReader(
      new FileSource(Bun.file(input)),
    ).open();
    expect((await legacy.tiles(0, 0, 0, 0, 0, ["buildings"]))[0]!.key).toBe(
      "tile/0/0/0",
    );
    await splitPackageLayers(input, output, 1e6);
    const migrated = await new AtlasReader(
      new FileSource(Bun.file(output)),
    ).open();
    expect(migrated.index.blocks[0]!.hash).toBe(legacy.index.blocks[0]!.hash);
    expect(await migrated.block("source/test")).toEqual(raw);
    for (const p of splitTile(bytes))
      expect(await migrated.block(`tile/${p.layer}/0/0/0`)).toEqual(p.bytes);
    const before = await Bun.file(input).arrayBuffer();
    await expect(splitPackageLayers(input, input, 10)).rejects.toThrow(
      "budget",
    );
    expect(await Bun.file(input).arrayBuffer()).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
