import { beforeAll, test, expect } from "bun:test";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { AtlasRouter, type Position } from "../packages/routing/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import {
  project,
  validateBlocks,
  type Block,
  type Manifest,
} from "../packages/format/src/index";
import type { BlockStore, SavedIndex } from "../packages/format/src/store";
import { AtlasEngine } from "../packages/operations/src/index";
import { createApiHandler } from "../apps/server/api";
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
class Store implements BlockStore {
  available = true;
  data = new Map<string, Uint8Array>();
  indexes = new Map<string, SavedIndex>();
  async getIndex(k: string) {
    return this.indexes.get(k);
  }
  async putIndex(k: string, v: SavedIndex) {
    this.indexes.set(k, v);
  }
  async get(s: string, b: Block) {
    return this.data.get(`${s}:${b.key}:${b.hash}`);
  }
  async put(s: string, b: Block, v: Uint8Array) {
    this.data.set(`${s}:${b.key}:${b.hash}`, v.slice());
  }
  async keys() {
    return [];
  }
}
function graph(points: Position[], ids: number[]) {
  const nodes = [...new Set(ids.flatMap((i) => [i, i + 1]))].sort(
    (a, b) => a - b,
  );
  const bytes = new Uint8Array(12 + nodes.length * 24 + ids.length * 20),
    v = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RTE1"));
  v.setUint32(4, nodes.length, true);
  v.setUint32(8, ids.length, true);
  nodes.forEach((id, i) => {
    const p = 12 + i * 24;
    v.setBigInt64(p, BigInt(id + 100), true);
    v.setFloat64(p + 8, points[id]![0], true);
    v.setFloat64(p + 16, points[id]![1], true);
  });
  ids.forEach((id, i) => {
    const p = 12 + nodes.length * 24 + i * 20;
    v.setUint32(p, nodes.indexOf(id), true);
    v.setUint32(p + 4, nodes.indexOf(id + 1), true);
    v.setBigInt64(p + 8, BigInt(id + 200), true);
    v.setUint8(p + 16, 3);
  });
  return bytes;
}
async function fixture(store?: Store, name = "cells") {
  const points: Position[] = [
    [16, 48],
    [16.02, 48],
    [16.02, 48.04],
    [16.06, 48.04],
    [16.06, 48],
    [16.08, 48],
  ];
  const all = graph(points, [0, 1, 2, 3, 4]),
    groups = new Map<string, number[]>();
  for (let i = 0; i < points.length - 1; i++) {
    const a = project(...points[i]!).map((v) => Math.floor(v * 16384)),
      b = project(...points[i + 1]!).map((v) => Math.floor(v * 16384));
    for (let x = Math.min(a[0]!, b[0]!); x <= Math.max(a[0]!, b[0]!); x++)
      for (let y = Math.min(a[1]!, b[1]!); y <= Math.max(a[1]!, b[1]!); y++) {
        const k = `routing/cells/14/${x}/${y}`;
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
  }
  const inputs: InputBlock[] = [{ key: "routing/walking", bytes: all }];
  for (const [key, ids] of groups) {
    const raw = graph(points, ids),
      bytes = new Uint8Array(16 + raw.length + ids.length * 4),
      v = new DataView(bytes.buffer),
      parts = key.split("/");
    bytes.set(new TextEncoder().encode("RCL1"));
    v.setUint32(4, 14, true);
    v.setUint32(8, +parts[3]!, true);
    v.setUint32(12, +parts[4]!, true);
    bytes.set(raw, 16);
    ids.forEach((id, i) => v.setUint32(16 + raw.length + i * 4, id, true));
    inputs.push({ key, bytes });
  }
  const manifest: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name,
    source: { url: "fixture", sha256: "0".repeat(64), attribution: "test" },
    bounds: [15.9, 47.9, 16.2, 48.2],
    minZoom: 0,
    maxZoom: 0,
    features: 5,
    peaks: 0,
    places: [],
    capabilities: ["walking-routing", "paged-walking-routing"],
    limitations: [],
    routing: {
      profile: "walking-v1",
      block: "routing/walking",
      nodes: 6,
      segments: 5,
      bytes: all.length,
      skippedWays: 0,
      snapLimitMeters: 150,
      scope: "retained-source-extract",
      cells: { zoom: 14, count: groups.size, codec: "rcl1" },
    },
  };
  const pkg = await encodePackage(manifest, inputs, { paged: true });
  const source = new FileSource(new Blob([pkg]));
  const reader = await new AtlasReader(source, undefined, {
    store,
    sourceId: "fixture",
  }).open();
  return {
    reader,
    source,
    pkg,
    points,
    router: new AtlasRouter(reader, async () => {}),
  };
}
test("paged WASM search pauses without false no-route and resumes to the reference result", async () => {
  const { reader, router, points } = await fixture();
  reader.offline = true;
  const paused = await router.route(points[0]!, points[5]!);
  expect(paused.status).toBe("missing-data");
  expect(reader.bytesByPurpose.routing).toBe(0);
  reader.offline = false;
  const result = await router.route(points[0]!, points[5]!);
  expect(result.status).toBe("found");
  expect(reader.cache.has("routing/walking")).toBe(false);
  const reference = new AtlasRouter(reader, async () => {}, {
    reference: true,
  });
  const baseline = await reference.route(points[0]!, points[5]!);
  if (result.status !== "found" || baseline.status !== "found")
    throw new Error("Missing route");
  expect(result.meters).toBeCloseTo(baseline.meters, 6);
  reader.offline = true;
  const reverse = await router.route(points[5]!, points[0]!);
  expect(reverse.status).toBe("found");
  expect(reverse.graphBytes).toBe(0);
  router.destroy();
  reference.destroy();
});
test("persisted compressed blocks and directory pages survive reader recreation with no network; snapshots remain isolated", async () => {
  const store = new Store();
  const { router, reader, points } = await fixture(store);
  const first = await router.route(points[0]!, points[5]!);
  router.destroy();
  const offline = await new AtlasReader(
    {
      read: async () => {
        throw new TypeError("Failed to fetch");
      },
    },
    undefined,
    { store, sourceId: "fixture" },
  ).open();
  expect(offline.offline).toBe(true);
  const second = new AtlasRouter(offline, async () => {});
  const result = await second.route(points[0]!, points[5]!);
  expect(result.status).toBe(first.status);
  expect(offline.requests).toBe(0);
  expect(result.graphBytes).toBe(0);
  second.destroy();
  const next = await fixture(store, "new snapshot");
  expect(next.reader.index.manifest.snapshot).not.toBe(
    reader.index.manifest.snapshot,
  );
  next.reader.offline = true;
  expect((await next.router.route(points[0]!, points[5]!)).status).toBe(
    "missing-data",
  );
  next.router.destroy();
});
test("corrupt stored routing bytes fail integrity, not missing-data or no-route", async () => {
  const store = new Store();
  const f = await fixture(store);
  await f.router.route(f.points[0]!, f.points[5]!);
  f.router.destroy();
  for (const [key, bytes] of store.data)
    if (key.includes(":routing/cells/")) {
      const bad = bytes.slice();
      bad[0] ^= 1;
      store.data.set(key, bad);
    }
  const reader = await new AtlasReader(f.source, undefined, { store }).open();
  reader.offline = true;
  const router = new AtlasRouter(reader, async () => {});
  await expect(router.route(f.points[0]!, f.points[5]!)).rejects.toThrow(
    "Integrity",
  );
  router.destroy();
});
test("server API uses the same paged engine and capability checks precede cached routes", async () => {
  const f = await fixture();
  const engine = new AtlasEngine(f.reader, async () => {}),
    api = createApiHandler(engine);
  const response = await api(
    new Request("http://localhost/api/route", {
      method: "POST",
      body: JSON.stringify({
        snapshot: f.reader.index.manifest.snapshot,
        input: { start: f.points[0], end: f.points[5] },
      }),
    }),
  );
  const data = await response.json();
  expect(response.status).toBe(200);
  expect(data.result.status).toBe("found");
  expect(data.result.cells.loadedCells).toBeGreaterThan(1);
  expect(f.reader.cache.has("routing/walking")).toBe(false);
  f.reader.options.purposes = ["map"];
  await expect(engine.route(f.points[0]!, f.points[5]!)).rejects.toThrow(
    "disabled",
  );
  engine.destroy();
  f.router.destroy();
});

test("routing cell metadata must match the directory and cell descriptors have bounded sizes", async () => {
  const f = await fixture();
  const blocks = await f.reader.allBlocks();
  const inputs = await Promise.all(
    blocks.map(async (b) => ({
      key: b.key,
      bytes: await f.reader.block(b.key),
    })),
  );
  const manifest = f.reader.index.manifest;
  const bad = await encodePackage(
    {
      ...manifest,
      routing: {
        ...manifest.routing!,
        cells: { ...manifest.routing!.cells!, count: 999 },
      },
    },
    inputs,
    { paged: true },
  );
  await expect(
    new AtlasReader(new FileSource(new Blob([bad]))).open(),
  ).rejects.toThrow("Routing cell directory");
  const block = blocks.find((b) => b.key.startsWith("routing/cells/"))!;
  expect(() =>
    validateBlocks(f.reader.index.header, manifest, [
      { ...block, codec: "gzip", rawLength: 17 * 1024 * 1024 },
    ]),
  ).toThrow("routing cell address or size");
  expect(() =>
    validateBlocks(f.reader.index.header, manifest, [
      { ...block, key: block.key.replace("/14/", "/014/") },
    ]),
  ).toThrow("routing cell address or size");
  f.router.destroy();
});
