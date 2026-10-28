import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { FeatureCollection, Polygon } from "geojson";
import { ObjectWriter } from "../packages/objects/src/build";
import {
  findObject,
  objectCatalog,
  objectRecords,
  objectGeometry,
  objectTopology,
  readObjects,
  intersectsGlobal,
  type SourceObject,
} from "../packages/objects/src/index";
import { objectOperation } from "../packages/objects/src/tools";
import { writeOceanObjects } from "../packages/objects/src/ocean";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { AtlasEngine } from "../packages/operations/src/index";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { preparePackage } from "../packages/provisioning/src/prepare";
import { WaterPatchWriter } from "../packages/cli/src/water-patch";
import { oceanTiles } from "../packages/cli/src/ocean-tiles";
const signal = () => new AbortController().signal;
const ring = (w: number, s: number, e: number, n: number) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const campus: SourceObject = {
  id: "way/1",
  tags: {
    amenity: "hospital",
    name: "Hospital grounds",
    landuse: "institutional",
  },
  geometry: {
    type: "Polygon",
    coordinates: [ring(16, 48, 16.08, 48.08), ring(16.03, 48.03, 16.05, 48.05)],
  },
  geometryStatus: "complete",
  nodeRefs: ["1", "2", "3", "4", "1"],
};
const tree: SourceObject = {
  id: "node/10",
  tags: { natural: "tree", species: "Tilia" },
  geometry: { type: "Point", coordinates: [16.01, 48.01] },
  geometryStatus: "complete",
};
const relation: SourceObject = {
  id: "relation/20",
  tags: { type: "site", name: "Hospital campus" },
  geometry: null,
  geometryStatus: "relation-members",
  members: [
    { id: "way/1", role: "building" },
    { id: "node/999", role: "entrance" },
  ],
  unavailableMembers: ["node/999"],
};
async function fixture(
  objects: SourceObject[] = [campus, tree, relation],
  onRead?: (e: any) => void,
  transform?: (blocks: InputBlock[]) => void,
) {
  const blocks: InputBlock[] = [];
  const w = new ObjectWriter({
    add: async (b) => {
      blocks.push(b);
    },
  });
  for (const obj of objects) await w.add(obj);
  await w.finish();
  transform?.(blocks);
  const bytes = await encodePackage(
    {
      format: "atlas",
      version: 1,
      name: "Source fixture",
      source: {
        url: "fixture",
        sha256: "a".repeat(64),
        attribution: "Synthetic",
      },
      bounds: [16, 48, 16.2, 48.2],
      minZoom: 0,
      maxZoom: 5,
      features: 0,
      peaks: 0,
      places: [],
      featureZoom: 12,
      featureKinds: ["objects"],
      capabilities: ["feature-extraction", "source-objects"],
      limitations: [],
      tileLayers: ["water"],
    },
    blocks,
    { paged: true },
  );
  return new AtlasReader(new FileSource(new Blob([bytes])), onRead).open();
}
test("generic sites, points and relations retain independent shapes, roles and attributes", async () => {
  const r = await fixture();
  expect((await objectCatalog(r)).report.counts).toEqual({
    node: 1,
    way: 1,
    relation: 1,
  });
  const row = (await findObject(r, "way/1"))!;
  expect(await objectGeometry(r, row)).toEqual(campus.geometry!);
  expect(await objectTopology(r, row)).toMatchObject({
    nodeRefs: campus.nodeRefs,
  });
  expect(
    await objectTopology(r, (await findObject(r, "relation/20"))!),
  ).toMatchObject({
    members: relation.members,
    unavailableMembers: ["node/999"],
  });
  const result: any = await objectOperation(
    [r],
    "object_search",
    { tag: { key: "natural", value: "tree" } },
    signal(),
  );
  expect(result.matches.map((x: any) => x.id)).toEqual(["node/10"]);
  r.dispose();
});
test("attribute queries skip geometry and pinned queries make no further source reads", async () => {
  const reads: string[] = [];
  const r = await fixture(undefined, (e) => reads.push(e.key)),
    w = new AtlasWorkspace([r], "interactive");
  const prepared = await w.prepare({
    bounds: [16, 48, 16.2, 48.2],
    families: ["objects"],
    geometry: false,
    where: [{ field: "tags.amenity", op: "eq", value: "hospital" }],
  });
  expect(prepared.records).toBe(1);
  expect(reads.some((k) => k.startsWith("objects/geometry/"))).toBe(false);
  const q = w.query({ workspace: prepared.workspace });
  const before = reads.length;
  r.dispose();
  expect(w.result(q.result).rows[0]!.id).toBe("way/1");
  expect(reads.length).toBe(before);
  w.clear();
});
test("exact geometry checks respect site holes; points are drawable across compatible sources", async () => {
  const a = await fixture(),
    b = await fixture();
  const f = [];
  for await (const row of readObjects(
    a,
    [16.035, 48.035, 16.045, 48.045],
    false,
  ))
    f.push(row);
  expect(f).toHaveLength(0);
  const runtime = new ChatDataRuntime([a, b]);
  const v = await runtime.invoke("object_get", { id: "node/10" }, signal());
  const engine = new AtlasEngine(a);
  const ref = engine.registry.catalog().find((r) => r.id === "object_get")!;
  const server: any = await engine.registry.invoke(ref, { id: "node/10" });
  expect((await runtime.resolve(v.result)).collection.features).toEqual(
    server.features,
  );
  const no = await runtime.invoke(
    "object_get",
    { id: "relation/20" },
    signal(),
  );
  expect(no.object.geometryStatus).toBe("relation-members");
  expect((await runtime.resolve(no.result)).collection.features).toHaveLength(
    0,
  );
  engine.destroy();
  a.dispose();
  b.dispose();
});
test("ID and spatial indexes work across multiple pages; dateline and polar point data are retained", async () => {
  const objects: SourceObject[] = Array.from({ length: 310 }, (_, i) => ({
    ...tree,
    id: `node/${1000 + i}`,
    geometry: { type: "Point", coordinates: [16 + i / 10000, 48.01] },
  }));
  objects.push(
    {
      id: "way/99",
      tags: { natural: "coastline" },
      geometry: {
        type: "LineString",
        coordinates: [
          [179, 10],
          [-179, 10],
        ],
      },
      geometryStatus: "complete",
    },
    {
      ...tree,
      id: "node/99",
      geometry: { type: "Point", coordinates: [0, 89] },
    },
  );
  const r = await fixture(objects);
  expect((await findObject(r, "node/1299"))!.id).toBe("node/1299");
  const hits = [];
  for await (const x of readObjects(r, [178, 9, -178, 11])) hits.push(x);
  expect(hits.map((x) => x.id)).toEqual(["way/99"]);
  expect(intersectsGlobal(hits[0]!.geometry!, [-1, 9, 1, 11])).toBe(false);
  const polar = [];
  for await (const x of readObjects(r, [-1, 88, 1, 90])) polar.push(x);
  expect(polar.map((x) => x.id)).toEqual(["node/99"]);
  r.dispose();
});
test("excerpts contain their own object indexes, geometry and relationships", async () => {
  const r = await fixture(),
    dir = await mkdtemp("/tmp/atlas-objects-excerpt-");
  try {
    await preparePackage(
      r,
      {
        snapshot: r.index.manifest.snapshot,
        name: "Slice",
        polygon: ring(16, 48, 16.02, 48.02).slice(0, -1) as [number, number][],
        minZoom: 0,
        maxZoom: 5,
        layers: [],
        profiles: [],
        featureKinds: ["objects"],
        placeNames: false,
        streetNames: false,
        pois: false,
        search: false,
        reverse: false,
        peaks: false,
        paddingCells: 0,
        maxBytes: 8 * 1024 ** 2,
      },
      dir + "/slice.atlas",
      signal(),
      () => {},
    );
    const slice = await new AtlasReader(
      new FileSource(Bun.file(dir + "/slice.atlas")),
    ).open();
    r.dispose();
    expect(
      await objectGeometry(slice, (await findObject(slice, "way/1"))!),
    ).toEqual(campus.geometry!);
    expect(
      (await objectTopology(slice, (await findObject(slice, "relation/20"))!))
        .members,
    ).toEqual(relation.members);
    slice.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
    r.dispose();
  }
});
test("ocean patch retains source objects and queryable sea holes without inventing coastline", async () => {
  const r = await fixture(),
    dir = await mkdtemp("/tmp/atlas-objects-ocean-");
  const ocean: FeatureCollection<Polygon> = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            ring(16, 48, 16.2, 48.2),
            ring(16.03, 48.03, 16.05, 48.05),
          ],
        },
      },
    ],
  };
  const patch = new WaterPatchWriter(
    r,
    dir + "/sea.atlas",
    128 * 1024 ** 2,
    signal(),
  );
  try {
    await patch.open();
    await oceanTiles(ocean, r.index.manifest, signal(), (b) => patch.add(b));
    await writeOceanObjects(
      r,
      { add: (b) => patch.addObjectBlock(b) },
      ocean,
      "b".repeat(64),
      signal(),
    );
    const { snapshot, ...manifest } = r.index.manifest;
    await patch.finish(manifest);
    const sea = await new AtlasReader(
      new FileSource(Bun.file(dir + "/sea.atlas")),
    ).open();
    expect(await findObject(sea, "way/1")).toBeDefined();
    const hits = [];
    for await (const row of objectRecords(sea, {
      tag: { key: "water", value: "ocean" },
    }))
      hits.push(row);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.facets).not.toContain("coastline");
    const g = (await objectGeometry(sea, hits[0]!))!;
    expect(intersectsGlobal(g, [16.035, 48.035, 16.045, 48.045])).toBe(false);
    sea.dispose();
  } catch (e) {
    await patch.abort();
    throw e;
  } finally {
    r.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("small excerpt plans skip remote geometry and preserve unlocated relationship records", async () => {
  const far = Array.from({ length: 2000 }, (_, i) => ({
    ...tree,
    id: `node/${2000 + i}`,
    geometry: { type: "Point" as const, coordinates: [16.15, 48.15] },
  }));
  const r = await fixture([...far, campus, tree, relation]);
  const { planPreparation } = await import(
    "../packages/provisioning/src/selection"
  );
  const plan = await planPreparation(r, {
    snapshot: r.index.manifest.snapshot,
    name: "Small",
    polygon: ring(16, 48, 16.02, 48.02).slice(0, -1) as [number, number][],
    minZoom: 0,
    maxZoom: 5,
    layers: [],
    profiles: [],
    featureKinds: ["objects"],
    placeNames: false,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    paddingCells: 0,
    maxBytes: 8 * 1024 ** 2,
  });
  const farRow = (await findObject(r, "node/3999"))!;
  expect(plan.blocks.some((b) => farRow.geometry!.blocks.includes(b.key))).toBe(
    false,
  );
  const rel = (await findObject(r, "relation/20"))!;
  expect(plan.blocks.some((b) => rel.topology!.blocks.includes(b.key))).toBe(
    true,
  );
  r.dispose();
});
test("relationships distinguish missing source members from untagged coordinate references", async () => {
  const r = await fixture();
  const out: any = await objectOperation(
    [r],
    "object_members",
    { id: "relation/20" },
    signal(),
  );
  expect(out.members.map((m: any) => m.availability)).toEqual([
    "retained-object",
    "missing-in-source",
  ]);
  const way: any = await objectOperation(
    [r],
    "object_members",
    { id: "way/1", limit: 2 },
    signal(),
  );
  expect(way.members[0].availability).toBe("coordinate-reference");
  expect(way.nextOffset).toBe(2);
  r.dispose();
});
test("invalid object payload references and cancellation fail before shape reads", async () => {
  const r = await fixture();
  const row = (await findObject(r, "way/1"))!;
  await expect(
    objectGeometry(r, { ...row, geometry: { bytes: 2 ** 32, blocks: [] } }),
  ).rejects.toThrow("Invalid object metadata");
  const abort = new AbortController();
  abort.abort();
  await expect(findObject(r, "way/1", abort.signal)).rejects.toThrow();
  r.dispose();
});

test("composed objects reject conflicting relationship memberships", async () => {
  const a = await fixture(),
    b = await fixture([
      campus,
      tree,
      { ...relation, members: [{ id: "way/1", role: "outer" }] },
    ]);
  try {
    await expect(
      objectOperation(
        [a, b],
        "object_members",
        { id: "relation/20" },
        signal(),
      ),
    ).rejects.toThrow("Conflicting source object relationships");
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("packed slices preserve shared points, UTF-8 roles and oversized multi-block payloads", async () => {
  const large = {
    ...campus,
    id: "way/999",
    geometry: {
      type: "LineString" as const,
      coordinates: Array.from({ length: 70000 }, (_, i) => [
        16 + i / 1e7,
        48 + i / 1e7,
      ]),
    },
  };
  const r = await fixture([
    tree,
    { ...tree, id: "node/11" },
    { ...relation, members: [{ id: "way/1", role: "entrée 🌍" }] },
    large,
  ]);
  try {
    expect((await objectCatalog(r)).schema).toBe("source-objects-v2");
    const a = (await findObject(r, "node/10"))!,
      b = (await findObject(r, "node/11"))!;
    expect(a.geometry!.blocks).toEqual(b.geometry!.blocks);
    expect(a.geometry!.offset).not.toBe(b.geometry!.offset);
    expect(await objectGeometry(r, b)).toEqual(tree.geometry!);
    expect(
      (await objectTopology(r, (await findObject(r, "relation/20"))!))
        .members?.[0]?.role,
    ).toBe("entrée 🌍");
    const big = (await findObject(r, "way/999"))!;
    expect(big.geometry!.offset).toBeUndefined();
    expect(big.geometry!.blocks.length).toBeGreaterThan(1);
    expect(await objectGeometry(r, big)).toEqual(large.geometry);
    await expect(
      objectGeometry(r, { ...a, geometry: { ...a.geometry!, offset: 65535 } }),
    ).rejects.toThrow("Invalid object metadata");
    await expect(
      objectGeometry(r, { ...a, geometry: { ...a.geometry!, offset: 60000 } }),
    ).rejects.toThrow("Invalid packed object slice");
  } finally {
    r.dispose();
  }
});

test("exact tag index prunes unrelated pages and handles empty, Unicode and delimiter values", async () => {
  const rows = Array.from({ length: 4000 }, (_, i) => ({
    ...tree,
    id: `node/${10000 + i}`,
    tags: { amenity: "cafe", name: `Cafe ${i}` },
  }));
  rows.push({ ...tree, id: "node/9999", tags: { amenity: "bench", name: "" } });
  const special = [
    { id: "node/1", tags: { a: "b=c" } },
    { id: "node/2", tags: { "a=b": "c" } },
    { id: "node/3", tags: { name: "𐀀 東京" } },
    { id: "node/4", tags: { name: "\uE000" } },
    { id: "node/5", tags: JSON.parse('{"__proto__":"value"}') },
  ].map((v) => ({ ...tree, ...v }));
  const reads: string[] = [];
  const r = await fixture([...rows, ...special], (e) => reads.push(e.key));
  try {
    const hits = [];
    for await (const row of objectRecords(r, {
      tag: { key: "amenity", value: "bench" },
    }))
      hits.push(row.id);
    expect(hits).toEqual(["node/9999"]);
    expect(reads.filter((k) => k.startsWith("objects/records/")).length).toBe(
      1,
    );
    expect(reads.some((k) => k.startsWith("objects/geometry/"))).toBe(false);
    for (const v of special) {
      const [key, value] = Object.entries(v.tags as Record<string, string>)[0]!;
      const matches = [];
      for await (const row of objectRecords(r, { tag: { key, value } }))
        matches.push(row.id);
      expect(matches).toEqual([v.id]);
    }
    const empty = [];
    for await (const row of objectRecords(r, {
      tag: { key: "name", value: "" },
    }))
      empty.push(row.id);
    expect(empty).toEqual(["node/9999"]);
    reads.length = 0;
    for await (const _ of objectRecords(r, {
      tag: { key: "amenity", value: "missing" },
    }))
      throw Error("unexpected hit");
    expect(reads.filter((k) => k.startsWith("objects/records/")).length).toBe(
      0,
    );
    const cafes = [];
    for await (const row of objectRecords(r, {
      tag: { key: "amenity", value: "cafe" },
    }))
      cafes.push(row.id);
    expect(cafes.length).toBe(4000);
  } finally {
    r.dispose();
  }
});

test("v1 catalogs and unshared geometry remain readable with exact-tag fallback", async () => {
  const r = await fixture([tree], undefined, (blocks) => {
    const catalog = blocks.find((b) => b.key === "objects/index")!;
    const c = JSON.parse(new TextDecoder().decode(catalog.bytes));
    c.schema = "source-objects-v1";
    delete c.tags;
    catalog.bytes = new TextEncoder().encode(JSON.stringify(c));
    for (const b of blocks.filter((b) =>
      b.key.startsWith("objects/records/"),
    )) {
      const v = JSON.parse(new TextDecoder().decode(b.bytes));
      for (const row of v.rows)
        for (const kind of ["geometry", "topology"]) {
          if (row[kind]) delete row[kind].offset;
        }
      b.bytes = new TextEncoder().encode(JSON.stringify(v));
    }
    for (let i = blocks.length - 1; i >= 0; i--)
      if (blocks[i]!.key.startsWith("objects/tag-")) blocks.splice(i, 1);
  });
  try {
    expect((await objectCatalog(r)).schema).toBe("source-objects-v1");
    const matches = [];
    for await (const row of objectRecords(r, {
      tag: { key: "natural", value: "tree" },
    }))
      matches.push(row);
    expect(matches.length).toBe(1);
    expect(await objectGeometry(r, matches[0]!)).toEqual(tree.geometry!);
  } finally {
    r.dispose();
  }
});
