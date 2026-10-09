import { beforeAll, expect, test } from "bun:test";
import {
  initSync,
  WalkingRouter,
} from "../packages/routing/pkg/atlas_routing_wasm";
import {
  validatePolygon,
  clipSegment,
  inside,
  type Polygon,
} from "../packages/offline/src/geometry";
import { clipGraph } from "../packages/offline/src/graph";
import { extract } from "../packages/offline/src/index";
import {
  AtlasReader,
  FileSource,
  decompress,
} from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import { DiskWriter } from "../packages/cli/src/disk-writer";
import type { Manifest } from "../packages/format/src/index";
import { mkdtemp, rm } from "node:fs/promises";
beforeAll(async () =>
  initSync({
    module: await Bun.file(
      new URL(
        "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
        import.meta.url,
      ),
    ).arrayBuffer(),
  }),
);
const square: Polygon = [
  [9.005, 46.995],
  [9.025, 46.995],
  [9.025, 47.005],
  [9.005, 47.005],
];
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "fixture",
  source: { url: "test", sha256: "0".repeat(64), attribution: "test" },
  bounds: [9, 46.9, 9.03, 47.1],
  minZoom: 0,
  maxZoom: 0,
  features: 1,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  limitations: [],
};
function graph() {
  const bytes = new Uint8Array(12 + 4 * 24 + 3 * 20),
    v = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RTE1"));
  v.setUint32(4, 4, true);
  v.setUint32(8, 3, true);
  for (let i = 0; i < 4; i++) {
    const o = 12 + i * 24;
    v.setBigInt64(o, BigInt(10 + i), true);
    v.setFloat64(o + 8, 9 + i * 0.01, true);
    v.setFloat64(o + 16, 47, true);
  }
  for (let i = 0; i < 3; i++) {
    const o = 12 + 4 * 24 + i * 20;
    v.setUint32(o, i, true);
    v.setUint32(o + 4, i + 1, true);
    v.setBigInt64(o + 8, 100n, true);
    v.setUint8(o + 16, 1);
  }
  return bytes;
}
test("polygon validation rejects crossings, zero area, repeats and date-line spans", () => {
  validatePolygon(square);
  for (const p of [
    [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 0],
    ],
    [
      [179, 0],
      [-179, 0],
      [179, 1],
    ],
  ] as Polygon[])
    expect(() => validatePolygon(p)).toThrow();
  expect(inside([9.005, 47], square)).toBe(true);
});
test("segment clipping retains boundary edges and every interval in a concave polygon", () => {
  const p: Polygon = [
    [0, 0],
    [3, 0],
    [3, 3],
    [2, 3],
    [2, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ];
  expect(clipSegment([-1, 2], [4, 2], p)).toEqual([
    [0.2, 0.4],
    [0.6, 0.8],
  ]);
  expect(clipSegment([-1, 0], [4, 0], p)).toEqual([[0.2, 0.8]]);
  expect(clipSegment([-1, -1], [4, -1], p)).toEqual([]);
  expect(clipSegment([0, 1], [3, 1], p)).toEqual([[0, 1]]);
});
test("clipped graph retains connectivity and one-way travel without outside detours", () => {
  const g = clipGraph(graph(), square);
  expect(g.nodes).toBe(4);
  expect(g.segments).toBe(3);
  const v = new DataView(g.bytes.buffer);
  const ids = Array.from({ length: 4 }, (_, i) =>
    v.getBigInt64(12 + i * 24, true),
  );
  expect(new Set(ids).size).toBe(4);
  expect(ids.filter((i) => i < 0n).length).toBe(2);
  const wasm = new WalkingRouter(g.bytes);
  try {
    const forward = JSON.parse(wasm.route(9.006, 47, 9.024, 47));
    expect(forward.status).toBe("found");
    expect(JSON.parse(wasm.route(9.024, 47, 9.006, 47)).status).toBe(
      "no-route",
    );
    expect(clipGraph(g.bytes, square).segments).toBe(3);
  } finally {
    wasm.free();
  }
});
test("compression verifies stored bytes and enforces the declared decoded length", async () => {
  const raw = new TextEncoder().encode("a".repeat(10000)),
    zipped = Bun.gzipSync(raw);
  expect(await decompress(zipped, raw.length)).toEqual(raw);
  await expect(decompress(zipped, 100)).rejects.toThrow("exceeds");
  await expect(decompress(zipped, 10001)).rejects.toThrow("mismatch");
  const pkg = await encodePackage(manifest, [
    { key: "test", bytes: zipped, codec: "gzip", rawLength: raw.length },
  ]);
  const reader = await new AtlasReader(new FileSource(new Blob([pkg]))).open();
  expect(await reader.block("test")).toEqual(raw);
  pkg[pkg.length - 1] ^= 1;
  const broken = await new AtlasReader(new FileSource(new Blob([pkg]))).open();
  await expect(broken.block("test")).rejects.toThrow("Integrity");
  expect(broken.cache.size).toBe(0);
});
test("disk writer produces readable compressed blocks and keeps old output if over budget", async () => {
  const dir = await mkdtemp("/tmp/atlas-writer-"),
    path = `${dir}/map.atlas`;
  try {
    const w = await new DiskWriter(path, 100000).open();
    await w.add({
      key: "hello",
      bytes: new TextEncoder().encode("hello".repeat(1000)),
    });
    await w.finish(manifest);
    const r = await new AtlasReader(new FileSource(Bun.file(path))).open();
    expect(r.index.blocks[0]!.codec).toBe("gzip");
    expect(new TextDecoder().decode(await r.block("hello"))).toBe(
      "hello".repeat(1000),
    );
    const old = await Bun.file(path).arrayBuffer(),
      tooSmall = await new DiskWriter(path, 20).open();
    await tooSmall.add({ key: "x", bytes: new Uint8Array([1]) });
    await expect(tooSmall.finish(manifest)).rejects.toThrow("budget");
    expect(await Bun.file(path).arrayBuffer()).toEqual(old);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("offline export carries zoom coverage, provenance, query clipping and compressed routing", async () => {
  const g = graph();
  const source = await encodePackage(
    {
      ...manifest,
      capabilities: ["vector-rendering", "walking-routing", "peak-query"],
      peaks: 2,
      routing: {
        block: "routing/walking",
        profile: "walking-v1",
        nodes: 4,
        segments: 3,
        bytes: g.length,
        skippedWays: 0,
        snapLimitMeters: 150,
        scope: "retained-source-extract",
      },
    },
    [
      {
        key: "tile/0/0/0",
        z: 0,
        x: 0,
        y: 0,
        features: 1,
        bytes: new TextEncoder().encode("tile"),
      },
      { key: "routing/walking", bytes: g },
      {
        key: "query/peaks",
        bytes: new TextEncoder().encode(
          JSON.stringify([
            {
              id: "node/1",
              name: "Inside",
              coordinates: [9.01, 47],
              elevation: 100,
            },
            {
              id: "node/2",
              name: "Outside",
              coordinates: [10, 47],
              elevation: 900,
            },
          ]),
        ),
      },
    ],
  );
  const parent = await new AtlasReader(
    new FileSource(new Blob([source])),
  ).open();
  const blob = await extract(parent, {
    name: "Drawn",
    polygon: square,
    minZoom: 0,
    maxZoom: 0,
    routing: true,
    search: false,
    queries: true,
  });
  const child = await new AtlasReader(new FileSource(blob)).open();
  expect(child.index.manifest.selection?.parentSnapshot).toBe(
    parent.index.manifest.snapshot,
  );
  expect(child.index.manifest.featureCountKind).toBe("tile-records");
  expect(child.index.manifest.routing?.segments).toBe(3);
  expect((await child.highestPeak()).peak?.name).toBe("Inside");
  expect(child.index.manifest.source).toEqual(parent.index.manifest.source);
  const mapSource = await new AtlasReader(
    new FileSource(new Blob([source])),
    undefined,
    { purposes: ["map", "labels"] },
  ).open();
  const mapOnly = await extract(mapSource, {
    name: "Map only",
    polygon: square,
    minZoom: 0,
    maxZoom: 0,
    routing: false,
    search: false,
  });
  const mapReader = await new AtlasReader(new FileSource(mapOnly)).open();
  expect(mapReader.index.manifest.capabilities).toEqual(["vector-rendering"]);
  expect(
    (await mapReader.allBlocks()).every((b) => b.key.startsWith("tile/")),
  ).toBe(true);
});
