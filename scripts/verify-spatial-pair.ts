/** Cached, multi-geometry analysis against the two Vienna rehearsal archives. */
import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
const paths = process.argv.slice(2);
if (!paths.length)
  paths.push(
    "data/pair-rehearsal/west-paged.atlas",
    "data/pair-rehearsal/east-paged.atlas",
  );
const readers: AtlasReader[] = [];
let runtime: ChatDataRuntime | undefined;
let reads = 0;
const bounds = [16.368, 48.198, 16.392, 48.218];
try {
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists()))
      throw new Error(`Missing ${path}; see docs/FEATURE-PAGING.md`);
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
    return r;
  };
  const prepared = await invoke("workspace_prepare", {
    bounds,
    families: ["buildings", "water", "roads", "railways", "land", "locations"],
    geometry: true,
  });
  assert.equal(prepared.coverage.status, "complete");
  assert.equal(prepared.snapshots.length, 2);
  const warmReads = reads,
    counts: Record<string, number> = {},
    refs: Record<string, string> = {};
  for (const family of [
    "buildings",
    "water",
    "roads",
    "railways",
    "land",
    "locations",
  ]) {
    const r = await invoke("workspace_query", {
      workspace: prepared.workspace,
      where: [{ field: "family", op: "eq", value: family }],
    });
    counts[family] = r.count;
    refs[family] = r.result;
    assert(r.count > 0, `Expected ${family} in the test area`);
  }
  const clipped = await invoke("spatial_clip", { result: refs.roads, bounds });
  const measured = await invoke("spatial_measure", { result: clipped.result });
  const lengths = await invoke("result_summary", {
    result: measured.result,
    field: "lengthM",
  });
  assert(lengths.statistics.sum > 0);
  const chart = runtime.chart({
    result: measured.result,
    title: "Road segment lengths",
    kind: "histogram",
    field: "lengthM",
    bins: 8,
    unit: "m",
  });
  const indexes = chart.bars!.flatMap((b) => b.indexes);
  assert.equal(new Set(indexes).size, measured.count);
  const selected = runtime.select(measured.result, chart.bars![0]!.indexes);
  const inspected = await invoke("feature_inspect", {
    result: selected.result,
    index: 0,
  });
  assert(inspected.properties.tags.highway);
  assert.equal(inspected.geometryType, "LineString");
  const waterBuffer = await invoke("spatial_buffer", {
    result: refs.water,
    distanceMeters: 100,
  });
  const nearby = await invoke("spatial_filter", {
    result: refs.buildings,
    other: waterBuffer.result,
  });
  assert(nearby.count > 0 && nearby.count < counts.buildings!);
  const nearest = await invoke("spatial_nearest", {
    result: refs.locations,
    other: refs.railways,
    maxDistanceMeters: 250,
  });
  assert(nearest.summary.matched > 0);
  const grid = await invoke("spatial_grid", {
    result: refs.locations,
    bounds,
    cellMeters: 250,
  });
  const gridSummary = await invoke("result_summary", {
    result: grid.result,
    field: "count",
  });
  assert.equal(gridSummary.statistics.sum, counts.locations);
  const landMeasure = await invoke("spatial_measure", { result: refs.land });
  const landSummary = await invoke("result_summary", {
    result: landMeasure.result,
    field: "areaM2",
  });
  assert(landSummary.statistics.sum > 0);
  assert.equal(
    reads,
    warmReads,
    "Analysis must not read any new source blocks",
  );
  console.log(
    JSON.stringify(
      {
        bounds,
        preparedRecords: prepared.records,
        sourceBytes: prepared.readBytes,
        counts,
        clippedRoadLengthMeters: lengths.statistics.sum,
        buildingsWithin100mOfRetainedWater: nearby.count,
        locationsWithin250mOfRetainedRail: nearest.summary.matched,
        gridCells: grid.count,
        followUpSourceReads: reads - warmReads,
        steps,
      },
      null,
      2,
    ),
  );
} finally {
  runtime?.clear();
  readers.forEach((r) => r.dispose());
}
