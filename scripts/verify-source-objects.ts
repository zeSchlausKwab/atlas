#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  findObject,
  objectCatalog,
  objectGeometry,
  objectTopology,
} from "../packages/objects/src/index";
import { boundaryOperation } from "../packages/boundaries/src/tools";
import { objectOperation } from "../packages/objects/src/tools";
import { AtlasWorkspace } from "../packages/workspace/src/index";
const dir = await mkdtemp("/tmp/atlas-source-objects-");
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  assert.equal(await p.exited, 0);
};
try {
  await run([
    "osmium",
    "cat",
    "tests/fixtures/source-objects.osm",
    "-o",
    dir + "/source.osm.pbf",
  ]);
  const options: Parameters<typeof compilePartitioned>[0] = {
    ocean: {
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [16.15, 48.15],
                  [16.2, 48.15],
                  [16.2, 48.2],
                  [16.15, 48.2],
                  [16.15, 48.15],
                ],
              ],
            },
          },
        ],
      },
      source: {
        url: "https://example.test/ocean",
        bytes: 100,
        sha256: "e".repeat(64),
      },
      clipHash: "f".repeat(64),
      clipBytes: 100,
    },
    input: dir + "/source.osm.pbf",
    output: dir + "/sample.atlas",
    work: dir + "/work",
    reserveBytes: 0,
    workers: 1,
    selection: {
      ocean: { sha256: "e".repeat(64) },
      snapshot: "fixture",
      name: "Analysis fixture",
      polygon: [
        [16, 48],
        [16.2, 48],
        [16.2, 48.2],
        [16, 48.2],
      ],
      minZoom: 0,
      maxZoom: 16,
      layers: ["water"],
      profiles: [],
      featureKinds: ["objects", "boundaries"],
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
      paddingCells: 0,
      maxBytes: 64 * 1024 ** 2,
    },
  };
  await compilePartitioned(options);
  await compilePartitioned({ ...options, output: dir + "/reused.atlas" });
  assert.deepEqual(
    await Bun.file(dir + "/sample.atlas").bytes(),
    await Bun.file(dir + "/reused.atlas").bytes(),
  );
  const r = await new AtlasReader(
    new FileSource(Bun.file(dir + "/sample.atlas")),
  ).open();
  const row = async (id: string) => {
    const row = await findObject(r, id);
    assert.ok(row, `Retained ${id}`);
    return row;
  };
  assert.equal((await objectGeometry(r, await row("way/20")))!.type, "Polygon");
  assert.equal((await row("node/20")).tags.natural, "tree");
  assert.equal((await row("node/21")).tags.barrier, "gate");
  assert.equal(
    (await objectGeometry(r, await row("way/22")))!.type,
    "LineString",
  );
  assert.equal(
    (await objectGeometry(r, await row("way/23")))!.type,
    "LineString",
  );
  assert.equal((await row("way/24")).geometryStatus, "missing-nodes");
  assert.equal((await row("relation/101")).geometryStatus, "incomplete-area");
  assert.equal(
    (await objectGeometry(r, await row("relation/201")))!.type,
    "MultiPolygon",
  );
  const site = await objectTopology(r, await row("relation/202"));
  assert.equal(site.members[0].id, "node/21");
  assert.equal(site.members[0].role, "entrance");
  assert.ok(Math.abs(site.members[0].coordinates[0] - 16.01) < 1e-10);
  assert.ok(Math.abs(site.members[0].coordinates[1] - 48.01) < 1e-10);
  const country = await objectTopology(r, await row("relation/200"));
  assert.ok(
    country.members.some(
      (m: any) => m.id === "relation/100" && m.role === "subarea",
    ),
  );
  assert.deepEqual(
    (await objectTopology(r, await row("relation/203"))).unavailableMembers,
    ["way/999997"],
  );
  const search: any = await boundaryOperation(
    [r],
    "boundary_search",
    { query: "Test country", adminLevel: "2" },
    new AbortController().signal,
  );
  assert.equal(search.matches[0].id, "relation/200");
  const direct: any = await objectOperation(
    [r],
    "object_search",
    { tag: { key: "boundary", value: "protected_area" } },
    new AbortController().signal,
  );
  assert.equal(direct.matches[0].id, "relation/201");
  assert.ok(r.index.manifest.capabilities.includes("land-sea-surfaces"));
  assert.ok(
    r.index.manifest.source.inputs!.some((i) => i.sha256 === "e".repeat(64)),
  );
  const sea: any = await objectOperation(
    [r],
    "object_search",
    { tag: { key: "water", value: "ocean" } },
    new AbortController().signal,
  );
  assert.equal(sea.matches.length, 1);
  assert.ok((await r.spatial("tile/water", 16, 0, 65535, 0, 65535)).length > 0);
  const catalog = await objectCatalog(r);
  const w = new AtlasWorkspace([r], "interactive");
  const prepared = await w.prepare({
    bounds: [16, 48, 16.2, 48.2],
    families: ["objects"],
    where: [{ field: "tags.natural", op: "eq", value: "tree" }],
  });
  assert.equal(prepared.records, 1);
  const q = w.query({ workspace: prepared.workspace });
  r.dispose();
  assert.equal(w.result(q.result).rows[0]!.id, "node/20");
  console.log(
    "SOURCE OBJECT ACCEPTANCE PASSED",
    JSON.stringify(
      { bytes: Bun.file(dir + "/sample.atlas").size, report: catalog.report },
      null,
      2,
    ),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
