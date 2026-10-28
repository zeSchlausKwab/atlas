#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  objectCatalog,
  objectRecords,
  readObjects,
} from "../packages/objects/src/index";
const root = process.argv[2] ?? "data/source-analysis-rehearsal";
await mkdir(root, { recursive: true });
const cases = [
  {
    name: "monaco",
    input:
      "data/hosted/sources/d1ff0048cfa6303ba472a38da75b5f22cf42ed1347d431006b549fff93d86b0b.osm.pbf",
    bounds: [7.408583, 43.483817, 7.595671, 43.75293],
    tag: { key: "natural", value: "coastline" },
  },
  {
    name: "vienna",
    input: "data/pair-rehearsal/area.osm.pbf",
    bounds: [16.27, 48.13, 16.51, 48.3],
    tag: { key: "amenity", value: "bench" },
  },
];
const results = [];
for (const c of cases) {
  const [w, s, e, n] = c.bounds as [number, number, number, number],
    output = `${root}/${c.name}.atlas`;
  const t = performance.now();
  await compilePartitioned({
    input: c.input,
    output,
    work: `${root}/${c.name}-work`,
    reserveBytes: 0,
    workers: 2,
    selection: {
      snapshot: "source-retention-benchmark",
      name: `${c.name} analysis source`,
      polygon: [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
      ],
      minZoom: 0,
      maxZoom: 16,
      layers: [],
      profiles: [],
      featureKinds: ["objects", "boundaries"],
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
      paddingCells: 0,
      maxBytes: 2 * 1024 ** 3,
    },
    progress: (message) => {
      if (!message.startsWith("ATLAS_PROGRESS")) console.log(c.name, message);
    },
  });
  const buildMs = performance.now() - t,
    keys: string[] = [];
  const r = await new AtlasReader(new FileSource(Bun.file(output)), (event) =>
    keys.push(event.key),
  ).open();
  const catalog = await objectCatalog(r);
  const before = r.bytesRead,
    start = performance.now();
  let matched = 0;
  for await (const row of objectRecords(r, { tag: c.tag })) matched++;
  const queryMs = performance.now() - start,
    attributeBytes = r.bytesRead - before;
  assert.ok(matched > 0, `${c.name} tagged objects retained`);
  assert.ok(!keys.some((k) => k.startsWith("objects/geometry/")));
  const small = c.name === "vienna" ? [16.39, 48.2, 16.43, 48.23] : c.bounds;
  const geomBefore = r.bytesRead,
    geomStart = performance.now();
  let shapes = 0;
  for await (const feature of readObjects(
    r,
    small as [number, number, number, number],
    true,
    undefined,
    () => true,
    undefined,
    { tag: c.tag },
  ))
    shapes++;
  const geometryMs = performance.now() - geomStart,
    geometryReadBytes = r.bytesRead - geomBefore;
  results.push({
    name: c.name,
    inputBytes: Bun.file(c.input).size,
    archiveBytes: Bun.file(output).size,
    buildMs,
    objects: catalog.count,
    query: { tag: c.tag, matched, attributeBytes, queryMs },
    geometry: {
      bounds: small,
      shapes,
      readBytes: geometryReadBytes,
      milliseconds: geometryMs,
    },
    retention: catalog.report,
  });
  r.dispose();
  await Bun.write(
    `${root}/measurements.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results.at(-1), null, 2));
}
