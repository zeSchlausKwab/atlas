import { test, expect } from "bun:test";
import init from "../packages/routing/pkg/atlas_routing_wasm";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import { buildFeatures } from "../packages/features/src/compile";
import {
  AtlasFeatures,
  asPolylines,
  type FeatureQuery,
} from "../packages/features/src/index";
import {
  AtlasEngine,
  RemoteOperations,
} from "../packages/operations/src/index";
import { createApiHandler } from "../apps/server/api";
import type { FeatureCollection } from "geojson";
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
async function fixture() {
  const graph = new Uint8Array(12 + 3 * 24 + 2 * 20),
    v = new DataView(graph.buffer);
  graph.set(new TextEncoder().encode("RTE1"));
  v.setUint32(4, 3, true);
  v.setUint32(8, 2, true);
  for (let i = 0; i < 3; i++) {
    const p = 12 + i * 24;
    v.setBigInt64(p, BigInt(100 + i), true);
    v.setFloat64(p + 8, 9 + i * 0.01, true);
    v.setFloat64(p + 16, 47, true);
  }
  for (let i = 0; i < 2; i++) {
    const p = 12 + 72 + i * 20;
    v.setUint32(p, i, true);
    v.setUint32(p + 4, i + 1, true);
    v.setBigInt64(p + 8, BigInt(200 + i), true);
    v.setUint8(p + 16, 3);
  }
  const source: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          id: "way/7",
          class: 1,
          name: "Test lake",
          tags: { natural: "water", water: "lake" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [9, 47],
              [9.12, 47],
              [9.12, 47.12],
              [9, 47.12],
              [9, 47],
            ],
            [
              [9.03, 47.03],
              [9.03, 47.06],
              [9.06, 47.06],
              [9.06, 47.03],
              [9.03, 47.03],
            ],
          ],
        },
      },
    ],
  };
  const cells = buildFeatures(source);
  expect(cells.size).toBeGreaterThan(1);
  const bytes = await encodePackage(
    {
      format: "atlas",
      version: 1,
      name: "Operations fixture",
      source: {
        url: "fixture",
        sha256: "0".repeat(64),
        attribution: "Test OSM data",
      },
      bounds: [8.99, 46.99, 9.2, 47.2],
      minZoom: 0,
      maxZoom: 0,
      features: 1,
      peaks: 1,
      places: [],
      featureZoom: 12,
      capabilities: [
        "vector-rendering",
        "walking-routing",
        "location-search",
        "reverse-street",
        "peak-query",
        "feature-extraction",
      ],
      limitations: [],
      routing: {
        block: "routing/walking",
        profile: "walking-v1",
        scope: "retained-source-extract",
        nodes: 3,
        segments: 2,
        bytes: graph.length,
        skippedWays: 0,
        snapLimitMeters: 150,
      },
    },
    [
      {
        key: "tile/0/0/0",
        z: 0,
        x: 0,
        y: 0,
        bytes: new Uint8Array([84, 73, 76, 49, 0, 0, 0, 0]),
      },
      { key: "routing/walking", bytes: graph },
      {
        key: "query/peaks",
        bytes: encode([
          {
            id: "node/9",
            name: "Test peak",
            coordinates: [9.01, 47.01],
            elevation: 1000,
          },
        ]),
      },
      {
        key: "search/locations",
        bytes: encode({
          schema: "locations-v1",
          records: [
            {
              id: "node/8",
              name: "Lake café",
              kind: "poi",
              category: "cafe",
              aliases: [],
              coordinates: [9.01, 47],
            },
          ],
        }),
      },
      {
        key: "search/streets",
        bytes: encode({
          schema: "streets-v1",
          streets: [
            {
              id: "way/200",
              name: "Lake street",
              category: "residential",
              aliases: [],
              coordinates: [
                [9, 47],
                [9.02, 47],
              ],
            },
          ],
        }),
      },
      ...[...cells].map(([key, features]) => ({
        key,
        bytes: encode({ schema: "features-v1", features }),
      })),
    ],
    { paged: true },
  );
  const reader = await new AtlasReader(
    new FileSource(new Blob([bytes])),
  ).open();
  const engine = new AtlasEngine(reader, () =>
    init({
      module_or_path: Bun.file(
        new URL(
          "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
          import.meta.url,
        ),
      ).arrayBuffer(),
    }),
  );
  return { reader, engine, bytes };
}
const query: FeatureQuery = {
  kind: "water",
  bounds: [8.99, 46.99, 9.13, 47.13],
  tag: "water=lake",
};
test("source feature pages stay cold until extraction, deduplicate shapes, preserve holes and tags", async () => {
  const { reader, engine } = await fixture();
  expect(reader.bytesByPurpose.features).toBe(0);
  expect(reader.index.tileCount).toBe(1);
  const result = await engine.query(query);
  expect(result.matched).toBe(1);
  expect(result.features[0]!.id).toBe("way/7");
  expect(result.features[0]!.properties.tags.water).toBe("lake");
  expect(result.features[0]!.geometry.type).toBe("Polygon");
  expect(asPolylines(result.features)[0]!.geometry.type).toBe(
    "MultiLineString",
  );
  expect(
    (await engine.query({ ...query, bounds: [9.04, 47.04, 9.05, 47.05] }))
      .matched,
  ).toBe(0);
  expect((await engine.query({ ...query, tag: "water=pond" })).matched).toBe(0);
  const before = reader.requests;
  reader.offline = true;
  expect((await engine.query(query)).matched).toBe(1);
  expect(reader.requests).toBe(before);
  await expect(
    engine.query({ ...query, bounds: [8, 46, 10, 48] }),
  ).rejects.toThrow("Zoom in");
  engine.destroy();
});
test("real HTTP operations match device routing/search/reverse/query/features; server graph never enters the client reader", async () => {
  const { reader, engine, bytes } = await fixture();
  const handler = createApiHandler(engine);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const clientReader = await new AtlasReader(
    new FileSource(new Blob([bytes])),
    undefined,
    { purposes: ["map", "labels"] },
  ).open();
  const remote = new RemoteOperations(
    new URL("/api", server.url).href,
    reader.index.manifest.snapshot,
  );
  try {
    const a: [number, number] = [9.002, 47],
      b: [number, number] = [9.018, 47];
    const local = await engine.route(a, b);
    const routed = await remote.call("route", {
      start: a,
      end: b,
    });
    expect(routed.result.status).toBe("found");
    expect(routed.result).toMatchObject({
      status: local.status,
      snapshot: local.snapshot,
    });
    if (local.status === "found" && routed.result.status === "found") {
      expect(routed.result.meters).toBe(local.meters);
      expect(routed.result.coordinates).toEqual(local.coordinates);
      expect(routed.result.wayIds).toEqual(local.wayIds);
    }
    expect(routed.execution.side).toBe("server");
    expect(routed.execution.responseBytes).toBeGreaterThan(0);
    expect(clientReader.bytesByPurpose.routing).toBe(0);
    const names = await engine.search("cafe");
    expect(
      (await remote.call("search", { query: "cafe" })).result.matches,
    ).toEqual(names.matches);
    const reverse = await engine.reverse([9.005, 47.0001]);
    expect(
      (
        await remote.call("reverse", {
          point: [9.005, 47.0001],
        })
      ).result.match,
    ).toEqual(reverse.match);
    const peaks = await engine.peak();
    expect((await remote.call("peak", {})).result).toEqual(peaks);
    const features = await engine.query(query);
    expect((await remote.call("features", query)).result).toEqual(features);
    const s: import("../packages/offline/src/index").Selection = {
      name: "Offline",
      polygon: [
        [8.999, 46.999],
        [9.021, 46.999],
        [9.021, 47.002],
        [8.999, 47.002],
      ],
      minZoom: 0,
      maxZoom: 0,
      routing: false,
      search: false,
    };
    const offline = await remote.call("offline", s);
    const child = await new AtlasReader(new FileSource(offline.result)).open();
    expect(child.index.manifest.selection?.parentSnapshot).toBe(
      reader.index.manifest.snapshot,
    );
    expect(child.index.manifest.capabilities).toEqual(["vector-rendering"]);
  } finally {
    engine.destroy();
    server.stop(true);
  }
});
test("API rejects mismatched snapshots and invalid requests before reading any data payload", async () => {
  const { reader, engine } = await fixture();
  const api = createApiHandler(engine),
    before = reader.requests;
  const request = (op: string, body: unknown) =>
    api(
      new Request(`http://localhost/api/${op}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  expect(
    (
      await request("route", {
        snapshot: "0".repeat(64),
        input: { start: [9, 47], end: [9.02, 47] },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request("route", {
        snapshot: reader.index.manifest.snapshot,
        input: { start: [999, 47], end: [9.02, 47] },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("features", {
        snapshot: reader.index.manifest.snapshot,
        input: { kind: "all", bounds: [0, 0, 90, 60] },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("search", {
        snapshot: reader.index.manifest.snapshot,
        input: { query: "x" },
      })
    ).status,
  ).toBe(400);
  expect(reader.requests).toBe(before);
  engine.destroy();
});

test("capability discovery describes actual dependencies and legacy coverage without reading payloads", async () => {
  const { reader, engine } = await fixture();
  const before = reader.bytesRead;
  const response = await createApiHandler(engine)(
    new Request("http://localhost/api/capabilities"),
  );
  expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(catalog.version).toBe(1);
  expect(catalog.snapshot).toBe(reader.index.manifest.snapshot);
  expect(catalog.operations.route.parameters.profiles).toEqual(["walking"]);
  expect(catalog.operations.route.dependencies).toEqual([
    { family: "routing/walking", schema: "rte", versions: [1] },
  ]);
  expect(catalog.operations.isochrone.available).toBe(false);
  expect(catalog.operations.search.available).toBe(true);
  expect(catalog.operations.reverse.available).toBe(true);
  expect(catalog.operations.peak.available).toBe(true);
  expect(catalog.coverage.completeness).toBe("source-extract-only");
  expect(reader.bytesRead).toBe(before);
  engine.destroy();
});
