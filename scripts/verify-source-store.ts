import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import type { Feature } from "geojson";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import { SourceGeocoding } from "../packages/geocoding/src/source-build";
import { buildGeocoding } from "../packages/geocoding/src/compile";
const input = process.argv[2] ?? "data/liechtenstein.osm.pbf",
  dir = await mkdtemp("/tmp/atlas-source-parity-");
async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: dir },
  });
  assert.equal(await p.exited, 0);
}
try {
  await run([
    "cargo",
    "build",
    "--release",
    "-p",
    "atlas-osm-import",
    "--bins",
  ]);
  await run([
    "target/release/atlas-osm-import",
    input,
    dir + "/reference.json",
    "--no-legacy-routing",
  ]);
  await run(["target/release/source-store", input, dir + "/source.sqlite"]);
  const ref = await Bun.file(dir + "/reference.json").json(),
    db = new Database(dir + "/source.sqlite", { readonly: true });
  let i = 0;
  for (const { data } of db
    .query<{ data: Uint8Array }, []>("SELECT data FROM features ORDER BY rowid")
    .iterate()) {
    const f = JSON.parse(
      new TextDecoder().decode(Bun.gunzipSync(data as Uint8Array<ArrayBuffer>)),
    );
    assert.deepEqual(f, ref.geojson.features[i++]);
  }
  assert.equal(i, ref.geojson.features.length);
  const expected = buildGeocoding(ref.locations, ref.geojson),
    builder = new PagedSearchBuilder(dir + "/search.sqlite"),
    semantic = new SourceGeocoding(db, builder, dir + "/groups.sqlite");
  await semantic.addNodes();
  // One feature at a time deliberately separates fragments of the same street into different partitions.
  for (const f of ref.geojson.features as Feature[])
    semantic.addFeatures({ type: "FeatureCollection", features: [f] });
  await semantic.finish();
  semantic.close();
  let actual: any[] = [];
  await builder.finish({
    add: async (b) => {
      if (b.key.startsWith("search/records/"))
        actual.push(...JSON.parse(new TextDecoder().decode(b.bytes)).records);
    },
  });
  assert.deepEqual(actual, expected.locations.records);
  console.log(
    JSON.stringify({
      features: i,
      locations: actual.length,
      streets: expected.streets.streets.length,
    }),
  );
  console.log(
    "PASS: disk-backed source geometry and globally grouped search records match the regional compiler.",
  );
  await builder.dispose();
  db.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
