import { expect, test } from "bun:test";
import {
  AtlasWorkspace,
  WorkspaceError,
} from "../packages/workspace/src/index";
import { AtlasEngine } from "../packages/operations/src/index";
import { createApiHandler } from "../apps/server/api";
import { AtlasGeocoder } from "../packages/geocoding/src/index";
import { buildLabels } from "../packages/labels/src/compile";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";

test("two packages prepare one pinned local task; queries reuse bytes, deduplicate IDs and preserve unknowns", async () => {
  let reads = 0;
  const west = await workspaceFixture(
    [16, 48, 16.012, 48.02],
    "18",
    () => reads++,
  );
  const east = await workspaceFixture(
    [16.008, 48, 16.02, 48.02],
    "18",
    () => reads++,
  );
  const w = new AtlasWorkspace([west.reader, east.reader]);
  const initial = reads;
  expect(w.catalog()[0]!.retention.addresses).toBe("osm-explicit");
  expect(reads).toBe(initial);
  const p = await w.prepare({
    bounds: taskBounds,
    families: ["buildings", "locations"],
  });
  expect(p.coverage.status).toBe("complete");
  expect(p.records).toBe(4); // one building geometry, its address anchor, two cafés
  const loaded = reads;
  west.reader.dispose();
  east.reader.dispose(); // cache is independent of the map reader
  const q = w.query({
    workspace: p.workspace,
    where: [{ field: "tags.amenity", op: "eq", value: "cafe" }],
  });
  expect(q.count).toBe(2);
  expect(
    q.preview.every((r) => r.geometry === undefined && r.tags === undefined),
  ).toBe(true);
  const unknown = w.query({
    workspace: p.workspace,
    from: q.result,
    where: [{ field: "tags.wheelchair", op: "exists", value: false }],
  });
  expect(unknown.count).toBe(1);
  expect(w.result(unknown.result).rows[0]!.id).toBe("node/2");
  const building = w.query({
    workspace: p.workspace,
    ids: ["way/10"],
    where: [{ field: "heightMeters", op: "gte", value: 15 }],
  });
  expect(building.count).toBe(1);
  expect(
    w.result(building.result, 0, 10, [
      "heightMeters",
      "heightSource",
      "geometry",
    ]).rows[0]!.heightMeters,
  ).toBe(18);
  expect(reads).toBe(loaded);
  w.release(p.workspace);
  expect(() => w.result(q.result)).toThrow(WorkspaceError);
});

test("coverage gaps and omitted families never masquerade as an empty complete result", async () => {
  const { reader } = await workspaceFixture([16, 48, 16.01, 48.02]);
  const w = new AtlasWorkspace([reader]);
  await expect(
    w.prepare({ bounds: taskBounds, families: ["locations"] }),
  ).rejects.toMatchObject({ code: "outside_coverage" });
  await expect(
    w.prepare({ bounds: taskBounds, families: ["water"] }),
  ).rejects.toMatchObject({ code: "unsupported_data" });
  const p = await w.prepare({
    bounds: taskBounds,
    families: ["water"],
    allowPartial: true,
  });
  const q = w.query({ workspace: p.workspace });
  expect(q.count).toBe(0);
  expect(q.coverage.status).toBe("partial");
  reader.dispose();
});

test("overlapping incompatible objects fail explicitly", async () => {
  const a = await workspaceFixture(),
    b = await workspaceFixture(taskBounds, "23");
  await expect(
    new AtlasWorkspace([a.reader, b.reader]).prepare({
      bounds: taskBounds,
      families: ["buildings"],
    }),
  ).rejects.toMatchObject({ code: "conflicting_data" });
  a.reader.dispose();
  b.reader.dispose();
});

test("cache-only does not fetch; budgets are enforced before the next payload read", async () => {
  let reads = 0;
  const { reader } = await workspaceFixture(taskBounds, "18", () => reads++),
    w = new AtlasWorkspace([reader]);
  const initial = reads;
  await expect(
    w.prepare({ bounds: taskBounds, families: ["locations"], cacheOnly: true }),
  ).rejects.toMatchObject({ code: "missing_blocks" });
  expect(reads).toBe(initial);
  await expect(
    w.prepare({ bounds: taskBounds, families: ["locations"], maxReadBytes: 1 }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(reads).toBe(initial);
  await expect(
    w.prepare({
      bounds: taskBounds,
      families: ["locations"],
      maxMemoryBytes: 1,
    }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(reads).toBe(initial);
  await reader.block("search/locations");
  const cached = reads;
  const p = await w.prepare({
    bounds: taskBounds,
    families: ["locations"],
    cacheOnly: true,
  });
  expect(p.readBytes).toBe(0);
  expect(reads).toBe(cached);
  reader.dispose();
});

test("HTTP tool registry exposes the same workspace lifecycle and typed failures", async () => {
  const { reader } = await workspaceFixture(),
    engine = new AtlasEngine(reader),
    api = createApiHandler(engine);
  const call = async (id: string, input: unknown) => {
    const response = await api(
      new Request(`http://localhost/api/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          snapshot: reader.index.manifest.snapshot,
          input,
        }),
      }),
    );
    return { response, body: await response.json() };
  };
  const bad = await call("workspace_prepare", {
    bounds: taskBounds,
    families: ["water"],
  });
  expect(bad.response.status).toBe(422);
  expect(bad.body.code).toBe("unsupported_data");
  const p = await call("workspace_prepare", {
    bounds: taskBounds,
    families: ["locations"],
  });
  expect(p.response.status).toBe(200);
  expect(p.body.execution.sourceBytes).toBeGreaterThan(0);
  const q = await call("workspace_query", {
    workspace: p.body.result.workspace,
    text: "Testgasse 12 Wien",
  });
  expect(q.response.status).toBe(200);
  expect(q.body.result.count).toBe(1);
  expect(q.body.execution.sourceBytes).toBe(0);
  const page = await call("workspace_result", {
    result: q.body.result.result,
    fields: ["id", "address.houseNumber", "address.city"],
  });
  expect(page.body.result.rows).toEqual([
    { id: "way/10", "address.houseNumber": "12", "address.city": "Wien" },
  ]);
  engine.destroy();
  reader.dispose();
});

test("explicit address search keeps structured components; POI label blocks omit semantic tags", async () => {
  const { reader, geo } = await workspaceFixture();
  const found = await new AtlasGeocoder(reader).search(
    "Testgasse 12 1010 Wien",
  );
  expect(found.matches[0]!.address).toMatchObject({
    houseNumber: "12",
    street: "Testgasse",
    city: "Wien",
    postcode: "1010",
    source: "osm-explicit",
  });
  const pois = [...buildLabels(geo.locations, geo.streets).values()].flatMap(
    (b) => b.pois,
  );
  expect(pois.length).toBeGreaterThan(0);
  expect(pois.every((p) => !("tags" in p) && !("address" in p))).toBe(true);
  reader.dispose();
});

test("normal client operation session prepares from the selected composition and respects data settings", async () => {
  const { OperationSession } = await import("../apps/web/src/operations");
  const a = await workspaceFixture([16, 48, 16.012, 48.02]),
    b = await workspaceFixture([16.008, 48, 16.02, 48.02]);
  const session = new OperationSession(a.reader, () => {}, [
    { id: "west", reader: a.reader },
    { id: "east", reader: b.reader },
  ]);
  const catalog = await session.catalog();
  const prepare = catalog.find((d) => d.id === "workspace_prepare")!,
    query = catalog.find((d) => d.id === "workspace_query")!;
  const p = await session.invokePlugin(
    prepare,
    { bounds: taskBounds, families: ["locations"] },
    new AbortController().signal,
  );
  expect((p.result as any).records).toBe(3);
  const q = await session.invokePlugin(
    query,
    { workspace: (p.result as any).workspace, text: "Coffee" },
    new AbortController().signal,
  );
  expect((q.result as any).count).toBe(2);
  expect(q.execution.sourceBytes).toBe(0);
  session.configure("device", ["features"]);
  await expect(
    session.invokePlugin(
      prepare,
      { bounds: taskBounds, families: ["locations"] },
      new AbortController().signal,
    ),
  ).rejects.toThrow("search is disabled");
  session.destroy();
  a.reader.dispose();
  b.reader.dispose();
});

test("house-number matching does not mistake 12 for 123", async () => {
  const { rankLocations, locations } = await import(
    "../packages/geocoding/src/index"
  );
  const record = {
    id: "node/123",
    kind: "address",
    category: "address",
    name: "Testgasse 123",
    aliases: [],
    coordinates: [16, 48],
    address: {
      houseNumber: "123",
      street: "Testgasse",
      source: "osm-explicit",
    },
  };
  const parsed = locations(
    new TextEncoder().encode(
      JSON.stringify({ schema: "locations-v1", records: [record] }),
    ),
  );
  expect(rankLocations(parsed, "testgasse 12")).toHaveLength(0);
  expect(rankLocations(parsed, "123 testgasse")).toHaveLength(1);
});

test("old packages cannot claim address or POI-tag coverage", async () => {
  const { reader } = await workspaceFixture();
  delete reader.index.manifest.semantics;
  await expect(
    new AtlasWorkspace([reader]).prepare({
      bounds: taskBounds,
      families: ["locations"],
      required: ["addresses"],
    }),
  ).rejects.toMatchObject({ code: "unsupported_data" });
  reader.dispose();
});

test("returned metadata cannot mutate pinned coverage, and inherited tag names are unknown", async () => {
  const { reader } = await workspaceFixture(),
    tasks = new AtlasWorkspace([reader]);
  const p = await tasks.prepare({
    bounds: taskBounds,
    families: ["locations"],
  });
  p.coverage.status = "partial";
  p.snapshots.length = 0;
  const q = tasks.query({
    workspace: p.workspace,
    where: [{ field: "tags.toString", op: "exists", value: true }],
  });
  expect(q.coverage.status).toBe("complete");
  expect(q.snapshots).toHaveLength(1);
  expect(q.count).toBe(0);
  tasks.clear();
  reader.dispose();
});
