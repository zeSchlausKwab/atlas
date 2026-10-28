#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  boundaryCatalog,
  findBoundary,
  containingBoundaries,
} from "../packages/boundaries/src/index";
const dir = await mkdtemp("/tmp/atlas-boundary-verification-");
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  assert.equal(await p.exited, 0);
};
try {
  await run([
    "osmium",
    "cat",
    "tests/fixtures/boundaries.osm",
    "-o",
    dir + "/source.osm.pbf",
  ]);
  await run([
    "target/release/atlas-osm-import",
    dir + "/source.osm.pbf",
    dir + "/reference.json",
    "--no-legacy-routing",
  ]);
  await run([
    "target/release/source-store",
    dir + "/source.osm.pbf",
    dir + "/source.sqlite",
  ]);
  const reference = await Bun.file(dir + "/reference.json").json(),
    db = new Database(dir + "/source.sqlite", { readonly: true });
  const rows = [
    ...db
      .query<
        { data: Uint8Array },
        []
      >("SELECT data FROM features WHERE class=9 ORDER BY id")
      .iterate(),
  ].map((r) =>
    JSON.parse(
      new TextDecoder().decode(
        Bun.gunzipSync(r.data as Uint8Array<ArrayBuffer>),
      ),
    ),
  );
  const expected = reference.geojson.features
    .filter((f: any) => f.properties.class === 9)
    .sort((a: any, b: any) => a.properties.id.localeCompare(b.properties.id));
  assert.deepEqual(rows, expected);
  assert.equal(rows.length, 3);
  assert.equal(reference.skippedRelations, 1);
  assert.deepEqual(
    rows.find((f) => f.properties.id === "relation/100").properties
      .boundaryRefs,
    ["node/13"],
  );
  assert.equal(
    rows.find((f) => f.properties.id === "relation/100").geometry.coordinates
      .length,
    2,
  );
  db.close();
  const selection = {
    snapshot: "fixture",
    name: "Boundary test",
    polygon: [
      [16, 48],
      [16.2, 48],
      [16.2, 48.2],
      [16, 48.2],
    ] as [number, number][],
    minZoom: 0,
    maxZoom: 16,
    layers: [],
    profiles: [],
    featureKinds: ["boundaries" as const],
    placeNames: false,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    paddingCells: 0,
    maxBytes: 1024 ** 2 * 10,
  };
  await compilePartitioned({
    input: dir + "/source.osm.pbf",
    output: dir + "/test.atlas",
    work: dir + "/compile",
    selection,
    reserveBytes: 0,
    workers: 1,
  });
  const reader = await new AtlasReader(
    new FileSource(Bun.file(dir + "/test.atlas")),
  ).open();
  assert.equal((await boundaryCatalog(reader)).count, 3);
  assert.equal((await findBoundary(reader, "node/13"))!.id, "relation/100");
  assert.equal(
    (await containingBoundaries(reader, [16.04, 48.04])).features.length,
    0,
  );
  assert.equal(
    (await containingBoundaries(reader, [16.01, 48.01])).features.length,
    1,
  );
  assert.equal(
    (await reader.allBlocks()).filter((b) => b.key.startsWith("tile/")).length,
    0,
  );
  reader.dispose();
  console.log(
    "PASS: OSM type=boundary, legacy multipolygons/ways, holes, islands, place links, incomplete-ring rejection, regional/disk importer parity and boundary-only compilation.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
