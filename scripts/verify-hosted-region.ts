/** Verify a hosted Vienna–Bratislava build through HTTP range reads and server tools. */
import { strict as assert } from "node:assert";
import { AtlasReader, HttpSource } from "../packages/format/src/reader";
import {
  AtlasEngine,
  RemoteOperations,
} from "../packages/operations/src/index";
import { PagedRouter, readRoutingCell } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { MAP_LAYERS, project } from "../packages/format/src/index";
const url = process.argv[2];
if (!url?.endsWith(".atlas"))
  throw new Error(
    "Usage: bun scripts/verify-hosted-region.ts http://host/maps/id.atlas [report.json]",
  );
const api = url.slice(0, -6) + "/api";
const reader = await new AtlasReader(new HttpSource(url)).open();
const m = reader.index.manifest;
assert.equal(m.minZoom, 0);
assert.equal(m.maxZoom, 16);
assert.ok(
  m.source.inputs?.some(
    (s) =>
      s.sha256 ===
      "1f0255832803e73280b634f0cd5767d287a9b63c15220388c7862efca393f9ef",
  ),
  "Expected the verified planet snapshot",
);
initSync({
  module: await Bun.file(
    "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
  ).arrayBuffer(),
});
const local = new AtlasEngine(reader, async () => {}),
  remote = new RemoteOperations(api, m.snapshot);
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  url,
  snapshot: m.snapshot,
  source: m.source,
  capabilities: m.capabilities,
  routes: [],
};
try {
  // Samples at every zoom, in both cities and on both sides of a partition seam.
  let tiles = 0;
  for (const z of [0, 5, 11, 12, 13, 14, 15, 16])
    for (const point of [
      [16.3696, 48.2027],
      [16.873, 48.2],
      [16.877, 48.2],
      [17.1128, 48.1452],
    ]) {
      const [x, y] = project(point[0]!, point[1]!).map((v) =>
        Math.floor(v * 2 ** z),
      );
      for (const layer of MAP_LAYERS)
        for (const b of await reader.spatial(
          `tile/${layer}`,
          z,
          x!,
          x!,
          y!,
          y!,
        )) {
          await reader.block(b.key);
          reader.cache.delete(b.key);
          tiles++;
        }
    }
  report.verifiedDisplaySamples = tiles;
  for (const query of ["Wien", "Bratislava"]) {
    const a = await local.search(query, 5),
      b = await remote.call("search", { query, limit: 5 });
    assert.ok(a.matches.length);
    assert.deepEqual(a.matches, b.result.matches);
    report[query] = a.matches.map((v) => ({ name: v.name, id: v.id }));
  }
  const start: [number, number] = [16.3696, 48.2027],
    end: [number, number] = [17.1128, 48.1452];
  const reverse = await local.reverse(start),
    reverseRemote = await remote.call("reverse", { point: start });
  assert.ok(reverse.match);
  assert.deepEqual(reverse.match, reverseRemote.result.match);
  const peak = await local.peak(),
    peakRemote = await remote.call("peak", {});
  assert.deepEqual(peak.peak, peakRemote.result.peak);
  report.nearestStreet = reverse.match?.name;
  report.peak = peak.peak;
  // Keep source-geometry queries within the intentional 64 MiB scan budget.
  for (const kind of ["buildings", "water", "railways"] as const) {
    console.log(`Checking ${kind} extraction near the Danube Canal…`);
    const q = {
      kind,
      bounds: [16.37, 48.205, 16.395, 48.225] as [
        number,
        number,
        number,
        number,
      ],
      limit: 10,
    };
    const a = await local.query(q),
      b = await remote.call("features", q);
    assert.ok(a.features.length);
    assert.deepEqual(a.features, b.result.features);
    report[kind] = a.features.length;
  }
  for (const profile of ["driving", "cycling", "walking"] as const) {
    const routeStart: [number, number] = [16.606, 48.116];
    const routeEnd: [number, number] = [16.94, 48.146];
    console.log(
      `Checking ${profile} ${routeStart} → ${routeEnd} on client and server…`,
    );
    const begin = performance.now(),
      a = await local.route(routeStart, routeEnd, profile),
      b = await remote.call("route", {
        start: routeStart,
        end: routeEnd,
        profile,
      });
    if (a.status !== "found")
      console.log("Client route:", JSON.stringify({ ...a, cells: undefined }));
    if (b.result.status !== "found")
      console.log(
        "Server route:",
        JSON.stringify({ ...b.result, cells: undefined }),
      );
    assert.equal(a.status, "found");
    assert.equal(b.result.status, "found");
    if (a.status !== "found" || b.result.status !== "found")
      throw new Error("Route incomplete");
    assert.deepEqual(a.coordinates, b.result.coordinates);
    assert.equal(a.seconds, b.result.seconds);
    assert.ok(
      a.coordinates.some((p) => p[0] < 16.875) &&
        a.coordinates.some((p) => p[0] > 16.875),
    );
    const summary = {
      profile,
      start: routeStart,
      end: routeEnd,
      meters: a.meters,
      seconds: a.seconds,
      visited: a.visited,
      loadedCells: a.cells?.loadedCells,
      clientMs: a.computeMs,
      serverMs: b.execution.computeMs,
      serverResponseBytes: b.execution.responseBytes,
      totalMs: performance.now() - begin,
    };
    (report.routes as unknown[]).push(summary);
    console.log(JSON.stringify(summary));
    const iso = await local.isochrone(start, [60, 180], profile),
      serverIso = await remote.call("isochrone", {
        start,
        bands: [60, 180],
        profile,
      });
    assert.equal(iso.status, "reachable");
    assert.equal(serverIso.result.status, "reachable");
    if (iso.status === "reachable" && serverIso.result.status === "reachable")
      assert.deepEqual(iso.contours, serverIso.result.contours);
  }
  // Longer searches are measured separately: outer coverage and search budgets
  // are real constraints, not compiler seam failures. Preserve them in the report.
  report.corridor = [];
  for (const profile of ["driving", "cycling", "walking"] as const) {
    console.log(`Checking full corridor limits: ${profile}…`);
    const a = await local.route(start, end, profile);
    const b = await remote.call("route", { start, end, profile });
    assert.equal(a.status, b.result.status);
    if (a.status === "missing-data" && b.result.status === "missing-data")
      assert.deepEqual(a.missing, b.result.missing);
    const summary: Record<string, unknown> = {
      profile,
      defaultClientStatus: a.status,
      defaultServerStatus: b.result.status,
      missing: a.status === "missing-data" ? a.missing : undefined,
      reason: a.status === "missing-data" ? a.reason : undefined,
    };
    if (profile !== "driving") {
      const router = new PagedRouter(
        m.snapshot,
        (key) => readRoutingCell(reader, key),
        () => {},
        async () => {},
        { searchStates: 1_000_000 },
      );
      try {
        const full = await router.route(
          start,
          end,
          profile,
          m.transport!.profiles[profile]!.prefix,
        );
        if (profile === "walking") assert.equal(full.status, "found");
        Object.assign(summary, {
          expandedClientBudget: 1_000_000,
          expandedClientStatus: full.status,
          expandedMissing:
            full.status === "missing-data" ? full.missing : undefined,
          expandedReason:
            full.status === "missing-data" ? full.reason : undefined,
        });
        if (full.status === "found")
          Object.assign(summary, {
            expandedClientBudget: 1_000_000,
            expandedClientStatus: full.status,
            meters: full.meters,
            seconds: full.seconds,
            visited: full.visited,
            clientMs: full.computeMs,
            cells: full.cells?.loadedCells,
          });
      } finally {
        router.destroy();
      }
    }
    (report.corridor as unknown[]).push(summary);
    console.log(JSON.stringify(summary));
  }
  report.clientBytesByPurpose = reader.bytesByPurpose;
  if (process.argv[3])
    await Bun.write(process.argv[3], JSON.stringify(report, null, 2));
  console.log(
    "PASS: hosted planet-derived map, sampled z0–16 blocks, search/reverse/peaks/features, Fischamend–Hainburg routes and isochrones agree in all three modes. Full-corridor coverage/budget limits recorded separately.",
  );
} finally {
  local.destroy();
  reader.dispose();
}
