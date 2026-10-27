/** Replays the Danube proximity use case using cached geometry, never model-authored cells. */
import assert from "node:assert/strict";
import area from "@turf/area";
import intersect from "@turf/intersect";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
import {
  fc,
  coordinates,
  type Surface,
  type Bounds,
} from "../packages/spatial/src/index";
const paths = process.argv.slice(2);
if (!paths.length)
  paths.push(
    "data/pair-rehearsal/west-paged.atlas",
    "data/pair-rehearsal/east-paged.atlas",
  );
const readers: AtlasReader[] = [];
let runtime: ChatDataRuntime | undefined,
  reads = 0;
const bounds: Bounds = [16.35, 48.2, 16.43, 48.25];
const ids = [
  "relation/17931263",
  "relation/18444",
  "relation/30218",
  "relation/32484",
  "relation/65901",
  "relation/75",
  "way/3870694",
];
try {
  for (const path of paths) {
    const file = Bun.file(path);
    assert(await file.exists(), `Missing ${path}`);
    const source = new FileSource(file);
    readers.push(
      await new AtlasReader({
        read: (a, b) => {
          reads++;
          return source.read(a, b);
        },
      }).open(),
    );
  }
  runtime = new ChatDataRuntime(readers);
  const steps: unknown[] = [];
  const invoke = async (name: string, input: unknown) => {
    const r = await runtime!.invoke(name, input, new AbortController().signal);
    steps.push({
      tool: name,
      count: r.count,
      sourceBytes: r.execution.sourceBytes,
      computeMs: Math.round(r.execution.computeMs),
    });
    console.error(`${name}: ${Math.round(r.execution.computeMs)} ms`);
    return r;
  };
  // Padding covers 500m around the final analysis area within the rehearsal pair.
  const prepared = await invoke("workspace_prepare", {
    bounds: [16.34, 48.19, 16.44, 48.258],
    families: ["water"],
    geometry: true,
  });
  const all = await invoke("workspace_query", {
    workspace: prepared.workspace,
  });
  const selected = await invoke("result_filter", { result: all.result, ids });
  assert(selected.count >= 4, "Expected retained Danube polygons");
  const selectedGeometry = await runtime.resolve(selected.result);
  assert(
    selectedGeometry.collection.features.every((f) =>
      /Polygon$/.test(f.geometry.type),
    ),
  );
  const warmReads = reads;
  const bands = await invoke("spatial_bands", {
    result: selected.result,
    distancesMeters: [100, 250, 500],
    bounds,
    toleranceMeters: 2,
  });
  const saved = await runtime.resolve(bands.result);
  assert.equal(saved.collection.features.length, 3);
  for (const f of saved.collection.features)
    for (const p of coordinates(f.geometry)) {
      assert(p[0]! >= bounds[0] - 1e-10 && p[0]! <= bounds[2] + 1e-10);
      assert(p[1]! >= bounds[1] - 1e-10 && p[1]! <= bounds[3] + 1e-10);
    }
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const overlap = intersect(
        fc([
          saved.collection.features[i] as Surface,
          saved.collection.features[j] as Surface,
        ]),
      );
      assert(!overlap || area(overlap) < 0.1, "Bands must not overlap");
    }
  const field = await invoke("field_create", {
    result: selected.result,
    kind: "distance",
    bounds,
    cellMeters: 25,
  });
  const contours = await invoke("field_contours", {
    field: field.field,
    thresholds: [0, 100, 250, 500],
  });
  const lines = await invoke("field_contours", {
    field: field.field,
    thresholds: [75, 200, 400],
    mode: "lines",
  });
  assert(contours.count > 0 && lines.count > 0);
  assert.equal(
    reads,
    warmReads,
    "Derived geometry and changed thresholds must not read source blocks",
  );
  const report = {
    bounds,
    preparedRecords: prepared.records,
    coverage: prepared.coverage,
    selectedWaterFeatures: selected.count,
    sourceIds: selectedGeometry.collection.features.map((f) => f.id),
    bands: saved.collection.features.map((f) => f.properties),
    field: {
      samples: field.samples,
      sampleBytes: field.sampleBytes,
      spacingMeters: field.spacingMeters,
    },
    followUpSourceReads: reads - warmReads,
    steps,
  };
  await Bun.write(
    "/tmp/atlas-continuous-verification.json",
    JSON.stringify(report, null, 2),
  );
  await Bun.write(
    "/tmp/atlas-danube-bands.geojson",
    JSON.stringify(saved.collection),
  );
  await Bun.write(
    "/tmp/atlas-danube-water.geojson",
    JSON.stringify(selectedGeometry.collection),
  );
  await Bun.write(
    "/tmp/atlas-danube-contours.geojson",
    JSON.stringify((await runtime.resolve(contours.result)).collection),
  );
  await Bun.write(
    "/tmp/atlas-danube-isolines.geojson",
    JSON.stringify((await runtime.resolve(lines.result)).collection),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  runtime?.clear();
  readers.forEach((r) => r.dispose());
}
