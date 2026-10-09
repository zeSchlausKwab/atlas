import { beforeAll, describe, expect, test } from "bun:test";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { AtlasRouter } from "../packages/routing/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import type { Manifest } from "../packages/format/src/index";
// Exercise the actual built WASM ABI, not a JavaScript replacement for the algorithm.
beforeAll(async () => {
  initSync({
    module: await Bun.file(
      new URL(
        "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
        import.meta.url,
      ),
    ).arrayBuffer(),
  });
});
async function fixture(directions = 3, malformed = false) {
  const bytes = new Uint8Array(12 + 3 * 24 + 2 * 20),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RTE1"));
  view.setUint32(4, 3, true);
  view.setUint32(8, 2, true);
  [9, 9.01, 9.02].forEach((lon, i) => {
    const p = 12 + i * 24;
    view.setBigInt64(p, BigInt(i + 100), true);
    view.setFloat64(p + 8, lon, true);
    view.setFloat64(p + 16, 47, true);
  });
  [0, 1].forEach((i) => {
    const p = 12 + 3 * 24 + i * 20;
    view.setUint32(p, i, true);
    view.setUint32(p + 4, i + 1, true);
    view.setBigInt64(p + 8, BigInt(i + 200), true);
    view.setUint8(p + 16, i === 0 ? directions : 3);
  });
  if (malformed) view.setUint32(12 + 3 * 24, 999, true);
  const manifest: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name: "Routing fixture",
    source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
    bounds: [8.99, 46.99, 9.03, 47.01],
    minZoom: 9,
    maxZoom: 9,
    features: 2,
    peaks: 0,
    places: [],
    capabilities: ["walking-routing"],
    limitations: [],
    routing: {
      profile: "walking-v1",
      block: "routing/walking",
      nodes: 3,
      segments: 2,
      bytes: bytes.length,
      skippedWays: 0,
      snapLimitMeters: 150,
      scope: "retained-source-extract",
    },
  };
  const pkg = await encodePackage(manifest, [
    { key: "routing/walking", features: 2, bytes },
  ]);
  const reader = await new AtlasReader(new FileSource(new Blob([pkg]))).open();
  return { reader, router: new AtlasRouter(reader), pkg };
}
describe("Package → verified block → Rust/WASM route", () => {
  test("lazy load and cached offline routing are independent of display tiles", async () => {
    const { reader, router } = await fixture();
    try {
      expect(reader.requests).toBe(2);
      expect(reader.cache.size).toBe(0);
      const route = await router.route([9.002, 47], [9.018, 47]);
      expect(route.status).toBe("found");
      expect(route.graphCached).toBe(false);
      expect(reader.requests).toBe(3);
      if (route.status !== "found") throw new Error("Expected route");
      expect(route.meters).toBeGreaterThan(1200);
      expect(route.meters).toBeLessThan(1230);
      expect(route.coordinates).toEqual([
        [9.002, 47],
        [9.01, 47],
        [9.018, 47],
      ]);
      expect(route.snapshot).toBe(reader.index.manifest.snapshot);
      reader.offline = true;
      const reverse = await router.route([9.018, 47], [9.002, 47]);
      expect(reverse.status).toBe("found");
      expect(reverse.graphCached).toBe(true);
      expect(reader.requests).toBe(3);
    } finally {
      router.destroy();
    }
  });
  test("a cold offline graph is missing data, and retry succeeds when online", async () => {
    const { reader, router } = await fixture();
    try {
      reader.offline = true;
      await expect(router.route([9, 47], [9.02, 47])).rejects.toThrow(
        "not cached",
      );
      expect(reader.requests).toBe(2);
      reader.offline = false;
      expect((await router.route([9, 47], [9.02, 47])).status).toBe("found");
    } finally {
      router.destroy();
    }
  });
  test("unreachable and too-far endpoints are distinct from unavailable bytes", async () => {
    const { router } = await fixture(1);
    try {
      expect((await router.route([9.018, 47], [9.002, 47])).status).toBe(
        "no-route",
      );
      expect((await router.route([8, 48], [9.002, 47])).status).toBe(
        "unsnappable",
      );
      await expect(router.route([NaN, 47], [9.002, 47])).rejects.toBeDefined();
    } finally {
      router.destroy();
    }
  });
  test("hashed but structurally invalid graph fails before routing", async () => {
    const { router } = await fixture(3, true);
    try {
      await expect(router.route([9, 47], [9.02, 47])).rejects.toBeDefined();
    } finally {
      router.destroy();
    }
  });
  test("concurrent requests share one graph read; disposed routers cannot route", async () => {
    const { reader, router } = await fixture();
    const results = await Promise.all([
      router.route([9, 47], [9.02, 47]),
      router.route([9.02, 47], [9, 47]),
    ]);
    expect(results.every((r) => r.status === "found")).toBe(true);
    expect(reader.requests).toBe(3);
    router.destroy();
    await expect(router.route([9, 47], [9.02, 47])).rejects.toThrow("disposed");
  });
});
