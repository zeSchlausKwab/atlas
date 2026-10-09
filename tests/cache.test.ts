import { expect, test } from "bun:test";
import { BudgetCache, DecodedCache } from "../packages/format/src/cache";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import type { Manifest, Block } from "../packages/format/src/index";
import {
  TileScheduler,
  type TileRequest,
} from "../packages/renderer/src/tile-scheduler";
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Budget fixture",
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
test("independent byte budgets preserve frequently used map blocks through routing churn", () => {
  const cache = new DecodedCache({ map: 4, routing: 4 });
  cache.set("tile/1", new Uint8Array(2));
  cache.set("tile/2", new Uint8Array(2));
  cache.get("tile/1");
  cache.set("tile/3", new Uint8Array(2));
  expect(cache.has("tile/1")).toBe(true);
  expect(cache.has("tile/2")).toBe(false);
  for (let i = 0; i < 100; i++)
    cache.set(`routing/cells/${i}`, new Uint8Array(3));
  expect(cache.has("tile/1")).toBe(true);
  expect(cache.stats.routing.bytes).toBe(3);
  cache.set("tile/huge", new Uint8Array(10));
  expect(cache.stats.map.bytes).toBeLessThanOrEqual(4);
  expect(cache.has("tile/huge")).toBe(false);
});
test("active meshes survive budget pressure and become evictable when the view releases them", () => {
  const disposed: string[] = [];
  const cache = new BudgetCache<string, number>(
    5,
    (n) => n,
    (_, k) => disposed.push(k),
  );
  cache.protect(["visible", "fallback"]);
  cache.set("visible", 4);
  cache.set("fallback", 4);
  expect(cache.stats.overage).toBe(3);
  expect(disposed).toEqual([]);
  cache.protect(["visible"]);
  expect(disposed).toEqual(["fallback"]);
  expect(cache.stats.overage).toBe(0);
  cache.clear();
  expect(disposed).toEqual(["fallback", "visible"]);
});
test("queries spanning more descriptors than the budget stay complete, including direct and concurrent reads", async () => {
  const inputs = Array.from({ length: 4096 }, (_, i) => ({
    key: `tile/8/${128 + (i % 64)}/${64 + Math.floor(i / 64)}`,
    z: 8,
    x: 128 + (i % 64),
    y: 64 + Math.floor(i / 64),
    features: 1,
    bytes: new Uint8Array([i % 256, Math.floor(i / 256)]),
  }));
  const bytes = await encodePackage(manifest, inputs, { paged: true });
  const r = await new AtlasReader(
    new FileSource(new Blob([bytes])),
    undefined,
    { directoryBudget: 1, cacheBudgets: { map: 4 } },
  ).open();
  expect(await r.tiles(8, 128, 191, 64, 127)).toHaveLength(4096);
  expect(await r.allBlocks()).toHaveLength(4096);
  expect(r.memory.directory.bytes).toBe(0);
  const result = await Promise.all([
    r.block(inputs[0]!.key),
    r.block(inputs[0]!.key),
    r.block(inputs[3000]!.key),
  ]);
  expect(result).toEqual([
    inputs[0]!.bytes,
    inputs[0]!.bytes,
    inputs[3000]!.bytes,
  ]);
  expect(r.memory.directory.evictions).toBeGreaterThan(1);
  expect(r.cache.stats.map.bytes).toBeLessThanOrEqual(4);
  r.offline = true;
  expect(await r.block(inputs[0]!.key)).toEqual(inputs[0]!.bytes);
});
function schedulerFixture(budget: number) {
  const blocks: Array<Block> = Array.from({ length: 3 }, (_, x) => ({
    key: `tile/roads/8/${x}/0`,
    z: 8,
    x,
    y: 0,
    features: 1,
    offset: x,
    length: 1,
    hash: "0".repeat(64),
  }));
  const uploaded: string[] = [],
    removed: string[] = [];
  let shown: string[] = [];
  const reader = {
    tilesCached: (_z: number, x: number) => ({
      complete: true,
      blocks: [blocks[x]!],
    }),
    block: async () => new Uint8Array([1]),
  } as unknown as AtlasReader;
  const scheduler = new TileScheduler(
    reader,
    {
      upload: (b) => {
        uploaded.push(b.key);
        return 4;
      },
      remove: (k) => removed.push(k),
      show: (keys) => {
        shown = keys;
      },
    },
    () => {},
    (e) => {
      throw new Error(e);
    },
    budget,
  );
  const view = (x: number): TileRequest => ({
    range: [8, x, x, 0, 0],
    layers: ["roads"],
    bounds: [x / 256, 0, (x + 1) / 256, 1 / 256],
  });
  const settle = async (x: number) => {
    for (let i = 0; i < 5; i++) {
      scheduler.update(view(x));
      await Promise.resolve();
    }
  };
  return { scheduler, uploaded, removed, shown: () => shown, settle, view };
}
test("panning back reuses GPU meshes; long pans evict old meshes without dropping visible coverage", async () => {
  const f = schedulerFixture(8);
  await f.settle(0);
  await f.settle(1);
  await f.settle(0);
  expect(f.uploaded).toHaveLength(2);
  expect(f.removed).toHaveLength(0);
  await f.settle(2);
  expect(f.removed).toEqual(["tile/roads/8/1/0"]);
  expect(f.shown()).toEqual(["tile/roads/8/2/0"]);
  expect(f.scheduler.memory.bytes).toBe(8);
  f.scheduler.destroy();
  expect(f.scheduler.memory.bytes).toBe(0);
});
test("a destroyed tile scheduler never uploads an in-flight response", async () => {
  const f = schedulerFixture(8);
  f.scheduler.update(f.view(0));
  f.scheduler.destroy();
  await Promise.resolve();
  expect(f.uploaded).toEqual([]);
});

test("disposed readers cannot refill decoded or persistent caches after late downloads", async () => {
  const key = "tile/8/128/64";
  const bytes = await encodePackage(manifest, [
    { key, z: 8, x: 128, y: 64, features: 1, bytes: new Uint8Array([1, 2]) },
  ]);
  const file = new FileSource(new Blob([bytes]));
  let unblock!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (unblock = r));
  let delay = false,
    writes = 0;
  const reader = await new AtlasReader(
    {
      read: async (s, e) => {
        if (delay) {
          started();
          await gate;
        }
        return file.read(s, e);
      },
    },
    undefined,
    {
      store: {
        available: true,
        getIndex: async () => undefined,
        putIndex: async () => {},
        get: async () => undefined,
        put: async () => {
          writes++;
        },
        keys: async () => [],
      },
    },
  ).open();
  delay = true;
  const pending = reader.block(key);
  void pending.catch(() => {});
  await waiting;
  reader.dispose();
  unblock();
  await expect(pending).rejects.toThrow("Map session closed");
  expect(writes).toBe(0);
  expect(reader.cache.size).toBe(0);
  await expect(reader.block(key)).rejects.toThrow("Map session closed");
});
