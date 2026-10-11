import geojsonvt from "geojson-vt";
import { encodeTile } from "../packages/cli/src/tile-codec";
import { encodePackage } from "../packages/format/src/writer";
import { decodeLabels } from "../packages/labels/src/index";
import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { preparePackage } from "../packages/provisioning/src/prepare";
import {
  planPreparation,
  validateSelection,
  type PackageSelection,
} from "../packages/provisioning/src/selection";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasEngine } from "../packages/operations/src/index";
import { readRoutingCell } from "../packages/routing/src/paged";
import { createApiHandler } from "../apps/server/api";
import { Preparations } from "../apps/server/preparations";
import { HostedLibrary } from "../apps/server/library";
import { pluginFixture, polygon, water } from "./helpers/plugin-fixture";
import { transportFixture, points } from "./helpers/transport-fixture";
import { operationCatalog } from "../packages/format/src/capabilities";
import { project } from "../packages/format/src/index";
import lake from "../plugins/lakes";
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
function selection(reader: AtlasReader): PackageSelection {
  return {
    snapshot: reader.index.manifest.snapshot,
    name: "Prepared test",
    polygon,
    minZoom: 0,
    maxZoom: 0,
    layers: [],
    placeNames: false,
    streetNames: false,
    pois: false,
    profiles: [],
    search: false,
    reverse: false,
    peaks: false,
    featureKinds: ["water"],
    paddingCells: 1,
    maxBytes: 1024 * 1024,
  };
}
const signal = () => new AbortController().signal;
test("a source-feature-only excerpt preserves lake IDs and holes, with an honest capability catalog", async () => {
  const f = await pluginFixture([
      water(1, 0.04, { water: "lake" }, 0.01),
      water(2, 0.1),
    ]),
    dir = await mkdtemp("/tmp/atlas-provision-");
  try {
    const s = selection(f.reader),
      plan = await planPreparation(f.reader, s);
    expect(plan.blocks.length).toBeGreaterThan(0);
    expect(f.reader.bytesByPurpose.features).toBe(0);
    const progress: string[] = [];
    await preparePackage(f.reader, s, dir + "/map.atlas", signal(), (p) =>
      progress.push(p.phase),
    );
    const reader = await new AtlasReader(
        new FileSource(Bun.file(dir + "/map.atlas")),
      ).open(),
      engine = new AtlasEngine(reader);
    engine.registry.register(lake, "test-lake");
    expect(reader.index.manifest.featureKinds).toEqual(["water"]);
    expect(reader.index.manifest.capabilities).toEqual(["feature-extraction"]);
    expect(reader.index.manifest.selection?.parentSnapshot).toBe(
      f.reader.index.manifest.snapshot,
    );
    expect(reader.index.manifest.snapshot).not.toBe(
      f.reader.index.manifest.snapshot,
    );
    const q = {
      kind: "water" as const,
      bounds: [9, 47, 9.2, 47.2] as [number, number, number, number],
    };
    expect((await engine.query(q)).features).toEqual(
      (await f.engine.query(q)).features,
    );
    await expect(engine.query({ ...q, kind: "buildings" })).rejects.toThrow(
      "does not contain",
    );
    expect(
      engine.registry.catalog().find((p) => p.id === lake.descriptor.id)
        ?.available,
    ).toBe(true);
    expect(
      operationCatalog(reader.index.manifest).operations.route.available,
    ).toBe(false);
    expect(progress).toContain("indexing");
    expect(await readdir(dir)).toEqual(["map.atlas"]);
    engine.destroy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("one travel mode survives preparation and matches local/server routing and isochrones", async () => {
  const f = await transportFixture(),
    dir = await mkdtemp("/tmp/atlas-provision-route-");
  try {
    const s = {
      ...selection(f.reader),
      polygon: [
        [15.99, 47.99],
        [16.01, 47.99],
        [16.01, 48.01],
        [15.99, 48.01],
      ] as [number, number][],
      featureKinds: [],
      profiles: ["cycling" as const],
    };
    await preparePackage(f.reader, s, dir + "/map.atlas", signal(), () => {});
    const reader = await new AtlasReader(
        new FileSource(Bun.file(dir + "/map.atlas")),
      ).open(),
      engine = new AtlasEngine(reader, async () => {}),
      api = createApiHandler(engine);
    expect(Object.keys(reader.index.manifest.transport!.profiles)).toEqual([
      "cycling",
    ]);
    expect(engine.capabilities.operations.route.parameters.profiles).toEqual([
      "cycling",
    ]);
    const route = await engine.route(points[0]!, points[2]!, "cycling");
    expect(route.status).toBe("found");
    expect(route.status === "found" && route.seconds).toBe(80);
    const r = await api(
      new Request("http://localhost/maps/example/api/route", {
        method: "POST",
        body: JSON.stringify({
          snapshot: reader.index.manifest.snapshot,
          input: { start: points[0], end: points[2], profile: "cycling" },
        }),
      }),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).result.coordinates).toEqual(
      route.status === "found" && route.coordinates,
    );
    const reach = await engine.isochrone(points[0]!, [30, 60], "cycling");
    expect(reach.status).toBe("reachable");
    const [x, y] = project(16.08, 48.08).map((v) => Math.floor(v * 16384));
    expect(
      (await readRoutingCell(reader, `routing/cycling/cells/14/${x}/${y}`))
        .missing,
    ).toBe(true);
    engine.destroy();
  } finally {
    f.router.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
test("selection validates snapshot, capabilities, bounds and polygon before reading payloads", async () => {
  const f = await pluginFixture(),
    s = selection(f.reader);
  for (const invalid of [
    { ...s, snapshot: "bad" },
    { ...s, profiles: ["driving"] },
    { ...s, search: true },
    {
      ...s,
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
    { ...s, featureKinds: [] },
    { ...s, maxBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => validateSelection(invalid, f.reader.index.manifest)).toThrow();
  expect(() =>
    validateSelection(
      { ...s, maxBytes: 10 * 1024 * 1024 * 1024 },
      f.reader.index.manifest,
    ),
  ).not.toThrow();
  expect(f.reader.bytesByPurpose.features).toBe(0);
  const abort = new AbortController();
  abort.abort();
  await expect(planPreparation(f.reader, s, abort.signal)).rejects.toThrow();
});
test("background jobs publish atomically, restore after restart, reject CSRF, and remove cancelled output", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-provision-jobs-");
  await Bun.write(dir + "/source.atlas", f.bytes);
  let manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  try {
    const info = await manager.handle(
      new Request("http://localhost/admin/preparations"),
      "127.0.0.1",
    );
    const payload = await info.json();
    expect(payload.storage.availableBytes).toBeGreaterThan(0);
    expect(payload.storage.totalBytes).toBeGreaterThanOrEqual(
      payload.storage.availableBytes,
    );
    const bad = await manager.handle(
      new Request("http://localhost/admin/preparations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection(f.reader)),
      }),
      "127.0.0.1",
    );
    expect(bad.status).toBe(403);
    const job = await manager.create(selection(f.reader));
    await expect(manager.create(selection(f.reader))).rejects.toThrow(
      "Another",
    );
    await until(() => !["running", "cancelling"].includes(job.state));
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    expect(manager.catalog()).toHaveLength(1);
    await manager.close();
    manager = await Preparations.open(
      dir + "/hosted",
      dir + "/source.atlas",
      f.reader.index.manifest,
    );
    expect(manager.catalog()[0]?.id).toBe(job.id);
    const cancelled = await manager.create(selection(f.reader));
    await manager.cancel(cancelled.id);
    await until(() => cancelled.state === "cancelled");
    expect(await Bun.file(manager.path(cancelled.id)).exists()).toBe(false);
    expect(
      (await readdir(dir + "/hosted")).some((n) => n.endsWith(".part")),
    ).toBe(false);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
async function until(predicate: () => boolean) {
  const end = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() > end) throw new Error("Preparation did not finish");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("display preparation removes unselected layers and clips independently selected labels and geocoding", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-provision-display-");
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const tile = encodeTile(
    geojsonvt(
      { type: "FeatureCollection", features: [water(1, 0.04)] },
      { maxZoom: 0 },
    ).getTile(0, 0, 0)!.features,
  );
  const [x, y] = project(9.02, 47.02).map((v) => Math.floor(v * 4096));
  const label = {
    schema: "labels-v1",
    roads: [
      {
        id: "way/4",
        name: "Clipped street",
        category: "residential",
        coordinates: [
          [9, 47.02],
          [9.1, 47.02],
        ],
      },
    ],
    pois: [],
  };
  const m = {
    ...f.reader.index.manifest,
    capabilities: [
      "vector-rendering",
      "map-labels",
      "location-search",
      "reverse-street",
    ],
    tileLayers: ["water", "roads"] as ("water" | "roads")[],
    labelZoom: 12,
    featureZoom: undefined,
  };
  const source = await encodePackage(
    m,
    [
      { key: "tile/water/0/0/0", z: 0, x: 0, y: 0, bytes: tile },
      { key: "tile/roads/0/0/0", z: 0, x: 0, y: 0, bytes: tile },
      { key: `labels/12/${x}/${y}/roads/15`, bytes: json(label) },
      {
        key: "search/locations",
        bytes: json({
          schema: "locations-v1",
          records: [
            {
              id: "node/1",
              name: "Inside",
              kind: "poi",
              category: "cafe",
              coordinates: [9.02, 47.02],
              aliases: [],
            },
            {
              id: "node/2",
              name: "Outside",
              kind: "poi",
              category: "cafe",
              coordinates: [9.1, 47.02],
              aliases: [],
            },
          ],
        }),
      },
      {
        key: "search/streets",
        bytes: json({ schema: "streets-v1", streets: label.roads }),
      },
    ],
    { paged: true },
  );
  const reader = await new AtlasReader(
    new FileSource(new Blob([source])),
  ).open();
  try {
    const s = {
      ...selection(reader),
      polygon: [
        [9.01, 47.01],
        [9.05, 47.01],
        [9.05, 47.05],
        [9.01, 47.05],
      ] as [number, number][],
      layers: ["water" as const],
      featureKinds: [],
      streetNames: true,
      search: true,
    };
    await preparePackage(reader, s, dir + "/map.atlas", signal(), () => {});
    const out = await new AtlasReader(
      new FileSource(Bun.file(dir + "/map.atlas")),
    ).open();
    expect(out.index.manifest.tileLayers).toEqual(["water"]);
    expect(out.index.manifest.capabilities).toEqual([
      "vector-rendering",
      "map-labels",
      "location-search",
    ]);
    expect(await out.spatial("tile/roads", 0, 0, 0, 0, 0)).toHaveLength(0);
    expect(out.index.blocks.some((b) => b.key === "search/streets")).toBe(
      false,
    );
    const labels = decodeLabels(
      await out.block(`labels/12/${x}/${y}/roads/15`),
    );
    expect(labels.roads[0]!.coordinates).toEqual([
      [9.01, 47.02],
      [9.05, 47.02],
    ]);
    expect(
      JSON.parse(
        new TextDecoder().decode(await out.block("search/locations")),
      ).records.map((r: any) => r.name),
    ).toEqual(["Inside"]);
    expect(reader.bytesByLayer.roads).toBe(0);
    expect(reader.bytesByPurpose.features).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("library datasets can be reused and deleted without deleting their sources or children", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-library-delete-");
  await Bun.write(dir + "/source.atlas", f.bytes);
  await Bun.write(dir + "/sources/planet.osm.pbf", "keep cached input");
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  const library = new HostedLibrary(
    manager,
    (reader) => new AtlasEngine(reader),
  );
  try {
    const parent = await manager.create(selection(f.reader));
    await expect(manager.delete(parent.id)).rejects.toThrow("Stop");
    await until(() => parent.state === "ready" || parent.state === "failed");
    expect(parent.state).toBe("ready");
    await manager.close();
    const info = await (
      await manager.handle(
        new Request("http://localhost/admin/preparations"),
        "127.0.0.1",
      )
    ).json();
    expect(info.atlasSources[0].id).toBe(parent.id);
    expect(info.atlasSources[0].available.featureKinds).toEqual(["water"]);
    await expect(
      manager.create({
        ...selection(f.reader),
        sourceAtlasId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("no longer available");
    await expect(
      manager.create({ ...selection(f.reader), sourcePlanId: "expired" }),
    ).rejects.toThrow("expired");
    await expect(
      manager.create({
        ...selection(f.reader),
        snapshot: parent.manifest!.snapshot,
        sourceAtlasId: parent.id,
        search: true,
      }),
    ).rejects.toThrow();
    const child = await manager.create({
      ...selection(f.reader),
      name: "Child",
      snapshot: parent.manifest!.snapshot,
      sourceAtlasId: parent.id,
    });
    await expect(manager.delete(parent.id)).rejects.toThrow(
      "active preparation",
    );
    await until(() => child.state === "ready" || child.state === "failed");
    expect(child.error).toBeUndefined();
    expect(child.state).toBe("ready");
    expect(child.manifest!.selection?.parentSnapshot).toBe(
      parent.manifest!.snapshot,
    );
    await manager.close();
    const range = await library.handle(
      new Request(`http://localhost/maps/${parent.id}.atlas`, {
        headers: { Range: "bytes=0-63" },
      }),
    );
    expect(range!.status).toBe(206);
    await range!.arrayBuffer();
    expect(
      (await library.handle(
        new Request(`http://localhost/maps/${parent.id}/api/capabilities`),
      ))!.status,
    ).toBe(200);
    await Bun.write(
      `${dir}/hosted/${parent.id}.work/checkpoint.json`,
      "saved stage",
    );
    await Bun.write(`${manager.path(parent.id)}.part`, "partial");
    const action = `http://localhost/admin/preparations/${parent.id}/delete`;
    expect(
      (
        await manager.handle(
          new Request(action, { method: "POST", body: "{}" }),
          "127.0.0.1",
        )
      ).status,
    ).toBe(403);
    expect(await Bun.file(manager.path(parent.id)).exists()).toBe(true);
    const deleted = await manager.handle(
      new Request(action, {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      "127.0.0.1",
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: parent.id });
    expect(manager.catalog().map((j) => j.id)).toEqual([child.id]);
    expect(
      (await readdir(dir + "/hosted")).some((name) =>
        name.startsWith(parent.id),
      ),
    ).toBe(false);
    expect(
      (await library.handle(
        new Request(`http://localhost/maps/${parent.id}.atlas`),
      ))!.status,
    ).toBe(404);
    expect(
      (await library.handle(
        new Request(`http://localhost/maps/${parent.id}/api/capabilities`),
      ))!.status,
    ).toBe(404);
    expect(
      (await library.handle(
        new Request(`http://localhost/maps/${child.id}/api/capabilities`),
      ))!.status,
    ).toBe(200);
    expect(await Bun.file(dir + "/source.atlas").exists()).toBe(true);
    expect(await Bun.file(dir + "/sources/planet.osm.pbf").text()).toBe(
      "keep cached input",
    );
  } finally {
    await library.close();
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

test("interrupted dataset deletion completes after restart and the base map is protected", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-delete-restart-");
  await Bun.write(dir + "/source.atlas", f.bytes);
  let manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  try {
    const job = await manager.create(selection(f.reader));
    await until(() => job.state === "ready");
    await manager.close();
    const protectedManager = await Preparations.open(
      dir + "/hosted",
      manager.path(job.id),
      job.manifest!,
    );
    await expect(protectedManager.delete(job.id)).rejects.toThrow("base map");
    await protectedManager.close();
    manager.beforeDelete = async () => {
      throw new Error("injected interrupted cleanup");
    };
    await expect(manager.delete(job.id)).rejects.toThrow("interrupted cleanup");
    expect(manager.catalog()).toHaveLength(0);
    expect(await Bun.file(manager.path(job.id)).exists()).toBe(true);
    await manager.close();
    manager = await Preparations.open(
      dir + "/hosted",
      dir + "/source.atlas",
      f.reader.index.manifest,
    );
    expect(manager.jobs.size).toBe(0);
    expect(await readdir(dir + "/hosted")).toEqual([]);
    expect(await Bun.file(dir + "/source.atlas").exists()).toBe(true);
    await expect(manager.delete("../source")).rejects.toThrow("Invalid");
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
