import {
  transportFixture as fixture,
  points,
} from "./helpers/transport-fixture";
import { beforeAll, expect, test } from "bun:test";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import {
  project,
  TRANSPORT_MODES,
  type Manifest,
  type TransportMetadata,
} from "../packages/format/src/index";
import { AtlasRouter, type Position } from "../packages/routing/src/index";
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
test("transport modes load only their own graph cells and optimize their directional times", async () => {
  const f = await fixture();
  const times = [];
  for (const mode of TRANSPORT_MODES) {
    const r = await f.router.route(points[0]!, points[2]!, mode);
    expect(r.status).toBe("found");
    if (r.status !== "found") throw Error("route");
    times.push(r.seconds);
    expect(r.profile).toBe(mode);
    expect(
      r.cells!.cells.every((c) => c.key.startsWith(`routing/${mode}/cells/`)),
    ).toBe(true);
  }
  expect(times).toEqual([240, 80, 40]);
  expect((await f.router.route(points[2]!, points[0]!, "driving")).status).toBe(
    "no-route",
  );
  const back = await f.router.route(points[2]!, points[0]!, "cycling");
  expect(back.status === "found" && back.seconds).toBe(120);
  f.router.destroy();
});
test("time contours pause, resume, remain nested, and exactly match the server", async () => {
  const f = await fixture();
  f.reader.offline = true;
  expect(
    (await f.router.isochrone(points[0]!, [30, 60, 120], "walking")).status,
  ).toBe("missing-data");
  expect(f.reader.bytesByPurpose.routing).toBe(0);
  f.reader.offline = false;
  const r = await f.router.isochrone(points[0]!, [30, 60, 120], "walking");
  expect(r.status).toBe("reachable");
  if (r.status !== "reachable") throw Error("area");
  expect(r.contours.features.map((f) => f.properties.seconds)).toEqual([
    30, 60, 120,
  ]);
  const area = r.contours.features.map((f) => f.properties.areaKm2);
  expect(area[0]!).toBeLessThanOrEqual(area[1]!);
  expect(area[1]!).toBeLessThanOrEqual(area[2]!);
  const engine = new AtlasEngine(await f.open(), async () => {}),
    api = createApiHandler(engine);
  const response = await api(
    new Request("http://localhost/api/isochrone", {
      method: "POST",
      body: JSON.stringify({
        snapshot: f.reader.index.manifest.snapshot,
        input: { start: points[0], bands: [30, 60, 120], profile: "walking" },
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).result.contours).toEqual(r.contours);
  f.reader.offline = true;
  expect(
    (await f.router.isochrone(points[0]!, [30, 60, 120], "walking")).graphBytes,
  ).toBe(0);
  expect(
    (await f.router.isochrone(points[0]!, [30, 60, 120], "cycling")).status,
  ).toBe("missing-data");
  f.reader.options.purposes = ["map"];
  expect(() => f.router.isochrone(points[0]!, [30], "walking")).toThrow(
    "disabled",
  );
  engine.destroy();
  f.router.destroy();
});
test("transport metadata and API time bands are validated before fetching graph data", async () => {
  const f = await fixture(),
    engine = new AtlasEngine(f.reader, async () => {}),
    api = createApiHandler(engine);
  for (const input of [
    { start: points[0], bands: [60, 30], profile: "walking" },
    { start: points[0], bands: [1801], profile: "cycling" },
    { start: points[0], bands: [60], profile: "flying" },
    { start: points[0], profile: "walking" },
  ]) {
    const r = await api(
      new Request("http://localhost/api/isochrone", {
        method: "POST",
        body: JSON.stringify({
          snapshot: f.reader.index.manifest.snapshot,
          input,
        }),
      }),
    );
    expect(r.status).toBe(400);
  }
  expect(f.reader.bytesByPurpose.routing).toBe(0);
  const bad = structuredClone(f.manifest);
  bad.transport!.profiles.driving!.count++;
  const bytes = await encodePackage(bad, f.inputs, { paged: true });
  await expect(
    new AtlasReader(new FileSource(new Blob([bytes]))).open(),
  ).rejects.toThrow("Transport cell directory");
  engine.destroy();
  f.router.destroy();
});

test("real PBF compiler preserves distinct access, vehicle direction and different-way U-turns", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/atlas-transport-import-");
  try {
    const proc = Bun.spawn(
      [
        "cargo",
        "run",
        "--quiet",
        "-p",
        "atlas-osm-import",
        "--bin",
        "transport-import",
        "--",
        "tests/fixtures/transport.osm.pbf",
        dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const errors = await new Response(proc.stderr).text();
    expect(await proc.exited, errors).toBe(0);
    const stats = await Bun.file(`${dir}/metadata.json`).json();
    expect(stats.walking.segments).toBe(3);
    expect(stats.cycling.segments).toBe(3);
    expect(stats.driving.segments).toBe(2);
    expect(stats.driving.turns).toBe(1);
    expect(stats.cycling.turns).toBe(0);
    for (const [mode, name] of TRANSPORT_MODES.entries()) {
      const bytes = new Uint8Array(
          await Bun.file(`${dir}/${name}.rte`).arrayBuffer(),
        ),
        v = new DataView(bytes.buffer),
        n = v.getUint32(4, true),
        e = v.getUint32(8, true);
      expect(v.getUint32(16, true)).toBe(mode);
      expect(v.getUint8(20 + n * 24 + 16)).toBe(mode === 2 ? 1 : 3);
      if (mode === 2) {
        expect(v.getUint8(20 + n * 24 + e * 28 + 24)).toBe(0);
        expect(v.getFloat32(20 + n * 24 + 20, true)).toBeGreaterThan(13);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("capability catalog selects profile-specific cells while offline export advertises walking only", async () => {
  const f = await fixture();
  const reader = f.reader;
  const { operationCatalog } = await import(
    "../packages/format/src/capabilities"
  );
  const c = operationCatalog(reader.index.manifest);
  expect(c.operations.route.parameters.profiles).toEqual([
    "walking",
    "cycling",
    "driving",
  ]);
  expect(c.operations.isochrone.dependencies.map((d) => d.family)).toEqual([
    "routing/walking/cells",
    "routing/cycling/cells",
    "routing/driving/cells",
  ]);
  expect(c.operations.isochrone.parameters.maxSeconds).toBe(1800);
  expect(
    c.operations.isochrone.dependencies.every((d) => d.versions[0] === 2),
  ).toBe(true);
  expect(c.operations.offline.parameters.profiles).not.toContain("driving");
});
