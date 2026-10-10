/** Small real-PBF acceptance test: interruption, resume, one archive, and a route across a display seam. */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import {
  importCachedPbf,
  planCachedBuild,
  type VerifiedBuildSource,
} from "../packages/provisioning/src/cached-build";
import { runCompiler } from "../packages/provisioning/src/process";
import { preparePackage } from "../packages/provisioning/src/prepare";
import type { PackageSelection } from "../packages/provisioning/src/selection";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { fileHash } from "../packages/cli/src/source";
import { AtlasEngine } from "../packages/operations/src/index";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
const dir = await mkdtemp("/tmp/atlas-cached-e2e-");
const signal = () => new AbortController().signal;
try {
  const positions = [
    [16.87, 48.2],
    [16.875, 48.2],
    [16.88, 48.2],
    [16.874, 48.201],
    [16.876, 48.201],
    [16.876, 48.202],
    [16.874, 48.202],
    [16.874, 48.203],
    [16.876, 48.203],
    [16.876, 48.204],
    [16.874, 48.204],
    [16.88, 48.201],
    [16.8745, 48.2012],
    [16.8755, 48.2012],
    [16.8755, 48.2018],
    [16.8745, 48.2018],
  ];
  await Bun.write(
    join(dir, "fixture.osm"),
    `<?xml version="1.0"?><osm version="0.6" generator="atlas-test">${positions.map(([lon, lat], i) => `<node id="${i + 1}" version="1" lon="${lon}" lat="${lat}">${i === 0 ? '<tag k="name" v="Seam town"/><tag k="place" v="town"/>' : i === 11 ? '<tag k="natural" v="peak"/><tag k="name" v="Test peak"/><tag k="ele" v="300"/>' : ""}</node>`).join("")}<way id="100" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Seam road"/></way><way id="101" version="1"><nd ref="4"/><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="4"/></way><way id="102" version="1"><nd ref="8"/><nd ref="9"/><nd ref="10"/><nd ref="11"/><nd ref="8"/><tag k="natural" v="water"/><tag k="water" v="lake"/><tag k="name" v="Seam lake"/></way><way id="103" version="1"><nd ref="13"/><nd ref="14"/><nd ref="15"/><nd ref="16"/><nd ref="13"/></way><relation id="200" version="1"><member type="way" ref="101" role="outer"/><member type="way" ref="103" role="inner"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/><tag k="height" v="18"/><tag k="name" v="Seam museum"/><tag k="tourism" v="museum"/></relation></osm>`,
  );
  const pbf = join(dir, "fixture.osm.pbf");
  await runCompiler(
    ["osmium", "cat", join(dir, "fixture.osm"), "-o", pbf],
    process.cwd(),
    signal(),
  );
  const s: PackageSelection = {
    snapshot: "geofabrik",
    name: "Cached seam fixture",
    polygon: [
      [16.86, 48.19],
      [16.89, 48.19],
      [16.89, 48.21],
      [16.86, 48.21],
    ],
    minZoom: 0,
    maxZoom: 16,
    layers: ["land", "water", "roads", "railways", "buildings", "peaks"],
    profiles: ["walking", "cycling", "driving"],
    placeNames: true,
    streetNames: true,
    pois: true,
    search: true,
    reverse: true,
    peaks: true,
    featureKinds: ["land", "water", "roads", "railways", "buildings"],
    paddingCells: 1,
    maxBytes: 64 * 1024 ** 2,
  };
  const info = await stat(pbf);
  const source: VerifiedBuildSource = {
    id: "a".repeat(32),
    kind: "planet",
    name: "Fixture planet",
    url: "fixture",
    path: pbf,
    sha256: await fileHash(pbf),
    bytes: info.size,
    mtimeMs: info.mtimeMs,
    md5: "",
    etag: "",
    lastModified: "2026-10-05T00:00:00Z",
    inspectedAt: "2026-10-10T00:00:00Z",
  };
  assert.ok(planCachedBuild(s).partitions.length >= 2);
  const abort = new AbortController();
  await assert.rejects(
    importCachedPbf(source, s, join(dir, "work"), abort.signal, (p) => {
      if (p.phase === "compiling") abort.abort();
    }),
  );
  const checkpoint = await Bun.file(join(dir, "work/build.json")).json();
  assert.ok(checkpoint.completed["area.osm.pbf"]);
  let reused = false;
  const compiled = await importCachedPbf(
    source,
    s,
    join(dir, "work"),
    signal(),
    (p) => {
      if (p.message.includes("Reused")) reused = true;
      console.log(p.message);
    },
  );
  assert.ok(reused);
  const root = await new AtlasReader(new FileSource(Bun.file(compiled))).open();
  // Compare all tiles with an independently generated non-partitioned reference.
  // The building courtyard and lake both straddle the ownership boundary.
  const reference = join(dir, "reference.atlas"),
    recipe = join(dir, "reference.json");
  await Bun.write(
    recipe,
    JSON.stringify({
      ...s,
      profiles: [],
      featureKinds: [],
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
    }),
  );
  await runCompiler(
    [
      process.execPath,
      "packages/cli/src/index.ts",
      "generate",
      "--input",
      join(dir, "work/area.osm.pbf"),
      "--output",
      reference,
      "--min-zoom",
      "0",
      "--max-zoom",
      "16",
      "--bounds",
      planCachedBuild(s).bounds.join(","),
      "--selection",
      recipe,
      "--no-source-features",
    ],
    process.cwd(),
    signal(),
  );
  const expected = await new AtlasReader(
    new FileSource(Bun.file(reference)),
  ).open();
  const actualTiles = (await root.allBlocks()).filter((b) =>
    b.key.startsWith("tile/"),
  );
  const expectedTiles = await expected.allBlocks();
  assert.deepEqual(
    actualTiles.map((b) => b.key).sort(),
    expectedTiles.map((b) => b.key).sort(),
  );
  for (const block of actualTiles)
    assert.deepEqual(
      await root.block(block.key),
      await expected.block(block.key),
      block.key,
    );
  expected.dispose();
  console.log(
    `${actualTiles.length} partitioned tiles exactly match the reference, including courtyard and lake seams.`,
  );
  const final = join(dir, "final.atlas");
  await preparePackage(
    root,
    { ...s, snapshot: root.index.manifest.snapshot },
    final,
    signal(),
    () => {},
  );
  root.dispose();
  const reader = await new AtlasReader(new FileSource(Bun.file(final))).open();
  initSync({
    module: await Bun.file(
      "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
    ).arrayBuffer(),
  });
  const engine = new AtlasEngine(reader, async () => {});
  assert.equal(reader.index.manifest.maxZoom, 16);
  for (const capability of [
    "vector-rendering",
    "transport-routing",
    "location-search",
    "reverse-street",
    "peak-query",
    "feature-extraction",
    "map-labels",
    "building-heights",
  ])
    assert.ok(
      reader.index.manifest.capabilities.includes(capability),
      capability,
    );
  for (const block of await reader.allBlocks()) {
    await reader.block(block.key);
    reader.cache.delete(block.key);
  }
  for (const mode of s.profiles) {
    const result = await engine.route([16.87, 48.2], [16.88, 48.2], mode);
    assert.equal(result.status, "found");
    console.log(`${mode}: route crosses 16.875° display partition seam`);
  }
  engine.destroy();
  console.log(
    "PASS: actual PBF → interrupted build → resume → one z0–16 map, all capabilities, three cross-seam routes.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
