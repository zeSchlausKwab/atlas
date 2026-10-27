/** Read-only acceptance for the large composed demo. Reads archive ranges, never whole files. */
import assert from "node:assert/strict";
import {
  AtlasReader,
  FileSource,
  HttpSource,
} from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
const paths = process.argv.slice(2);
if (paths.length !== 2)
  throw Error(
    "Usage: bun scripts/verify-large-pair.ts WEST.atlas EAST.atlas (paths or HTTP URLs)",
  );
const readers = await Promise.all(
  paths.map((path) =>
    new AtlasReader(
      /^https?:/.test(path)
        ? new HttpSource(path)
        : new FileSource(Bun.file(path)),
    ).open(),
  ),
);
const runtime = new ChatDataRuntime(readers),
  signal = new AbortController().signal;
const timings: unknown[] = [];
const call = async (name: string, args: unknown) => {
  const result = await runtime.invoke(name, args, signal);
  timings.push({
    name,
    count: result.count,
    records: result.records,
    ...result.execution,
  });
  console.error(
    name,
    result.count ?? result.records ?? "",
    Math.round(result.execution.computeMs) + " ms",
    result.execution.sourceBytes + " bytes",
  );
  return result;
};
try {
  const manifests = readers.map((r) => r.index.manifest);
  for (const m of manifests) {
    assert.equal(m.minZoom, 0);
    assert.equal(m.maxZoom, 16);
    assert.equal(m.semantics?.addresses, "osm-explicit");
    for (const profile of ["walking", "cycling", "driving"] as const)
      assert(m.transport?.profiles[profile]);
    for (const kind of [
      "buildings",
      "land",
      "water",
      "roads",
      "railways",
    ] as const)
      assert(m.featureKinds?.includes(kind));
  }
  assert.equal(
    manifests[0]!.transport!.graphSnapshot,
    manifests[1]!.transport!.graphSnapshot,
  );
  const prepared = await call("workspace_prepare", {
    bounds: [16.3, 48.1, 17.2, 48.3],
    families: ["buildings"],
    geometry: true,
  });
  assert.equal(prepared.coverage.status, "complete");
  assert.equal(prepared.snapshots.length, 2);
  assert(prepared.records > 10000);
  const all = await call("workspace_query", { workspace: prepared.workspace });
  const heights = await call("analyze", {
    result: all.result,
    operation: "stats",
    field: "heightMeters",
  });
  assert.equal(heights.known + heights.unknown, all.count);
  const tall = await call("workspace_query", {
    workspace: prepared.workspace,
    where: [{ field: "heightMeters", op: "gte", value: 20 }],
  });
  assert.equal(tall.execution.sourceBytes, 0);
  const before = readers.reduce((n, r) => n + r.bytesRead, 0);
  const again = await call("analyze", {
    result: all.result,
    operation: "stats",
    field: "heightMeters",
  });
  assert.equal(again.known, heights.known);
  assert.equal(
    readers.reduce((n, r) => n + r.bytesRead, 0),
    before,
  );
  // Named geometry can be outside any currently visible area; merged overlap produces one footprint.
  const found = await call("search", {
    query: "Stadtpark Wien",
    tag: { key: "leisure", value: "park" },
    limit: 10,
  });
  const chosen = found.matches.find((x: any) => x.name === "Stadtpark");
  assert(chosen);
  const park = await call("place_geometry", {
    result: found.result,
    id: chosen.id,
  });
  assert(park.boundaryAvailable);
  const band = await call("spatial_bands", {
    result: park.result,
    distancesMeters: [100, 250, 500],
    excludeSource: true,
  });
  const check = await call("result_check", {
    result: band.result,
    excludeResult: park.result,
    disjoint: true,
  });
  assert(check.checks.passed);
  const address = await call("search", { query: "Handelskai 300", limit: 5 });
  assert(address.matches.some((x: any) => x.address?.houseNumber === "300"));
  // Release the large pinned analysis before routing; the browser exposes the same release tool.
  await call("workspace_release", { workspace: prepared.workspace });
  initSync({
    module: await Bun.file(
      new URL(
        "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
        import.meta.url,
      ),
    ).arrayBuffer(),
  });
  const routes = [];
  for (const mode of ["walking", "cycling", "driving"] as const) {
    const composition = new RoutingComposition(
      readers.map((reader, i) => ({ id: String(i), reader })),
    );
    let last = 0;
    const started = performance.now();
    const router = new PagedRouter(
      composition.snapshot,
      (k) => composition.read(k),
      (p) => {
        if (performance.now() - last > 10000) {
          last = performance.now();
          console.error(mode, p.phase, p.visited, p.loadedCells);
        }
      },
      async () => {},
      { searchStates: 2_000_000 },
    );
    try {
      const route = await router.route(
        [16.3696, 48.2027],
        [17.1128, 48.1452],
        mode,
        composition.prefix(mode),
      );
      const owners = [
        ...new Set([...composition.served.values()].map((v) => v.source)),
      ];
      assert.equal(route.status, "found");
      assert.equal(owners.length, 2);
      routes.push({
        mode,
        status: route.status,
        meters: route.status === "found" ? route.meters : null,
        owners,
        ms: performance.now() - started,
        cells: route.cells?.loadedCells,
        memoryBytes: route.cells?.memoryBytes,
      });
    } finally {
      router.destroy();
    }
  }
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        files: paths,
        archiveBytes: readers.map((r) => r.index.header.fileLength),
        records: prepared.records,
        tallBuildings: tall.count,
        knownHeight: heights.known,
        unknownHeight: heights.unknown,
        followupBytes: 0,
        polygonChecks: check.checks,
        routes,
        timings,
        sourceBytes: readers.reduce((n, r) => n + r.bytesRead, 0),
      },
      null,
      2,
    ),
  );
} finally {
  runtime.clear();
  readers.forEach((r) => r.dispose());
}
