/** Real two-chunk suitability rehearsal. Geometry operations stay local after preparation. */
import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
const readers = await Promise.all(
  ["west", "east"].map(async (side) =>
    new AtlasReader(
      new FileSource(Bun.file(`data/pair-rehearsal/${side}-paged.atlas`)),
    ).open(),
  ),
);
const runtime = new ChatDataRuntime(readers),
  signal = new AbortController().signal;
const timings: any[] = [];
const call = async (name: string, args: any) => {
  console.error(name);
  const r = await runtime.invoke(name, args, signal);
  timings.push({
    name,
    count: r.count,
    ms: Math.round(r.execution.computeMs),
    bytes: r.execution.sourceBytes,
  });
  console.error(timings.at(-1));
  return r;
};
try {
  const p = await call("workspace_prepare", {
    bounds: [16.3, 48.16, 16.46, 48.26],
    families: ["buildings", "land", "railways", "locations"],
    geometry: true,
  });
  const query = (where: any[]) =>
    call("workspace_query", { workspace: p.workspace, where });
  const parks = await query([
    { field: "tags.leisure", op: "eq", value: "park" },
    { field: "geometryType", op: "contains", value: "Polygon" },
  ]);
  const rails = await query([{ field: "family", op: "eq", value: "railways" }]);
  const stops = await query([
    { field: "family", op: "eq", value: "locations" },
    { field: "tags.railway", op: "eq", value: "tram_stop" },
  ]);
  const buildings = await query([
    { field: "family", op: "eq", value: "buildings" },
  ]);
  assert(
    parks.count > 0 &&
      rails.count > 0 &&
      stops.count > 0 &&
      buildings.count > 0,
  );
  const recipe = await call("recipe_define", {
    title:
      "Buildings near parks and tram stops, outside retained railway corridors",
    parameters: {
      park: { value: 400, min: 100, max: 800, unit: "m" },
      rail: { value: 100, min: 20, max: 300, unit: "m" },
      tram: { value: 800, min: 200, max: 1200, unit: "m" },
    },
    steps: [
      {
        id: "parks",
        tool: "spatial_buffer",
        args: { result: parks.result, distanceMeters: "$param.park" },
      },
      {
        id: "rails",
        tool: "spatial_buffer",
        args: { result: rails.result, distanceMeters: "$param.rail" },
      },
      {
        id: "stops",
        tool: "spatial_buffer",
        args: { result: stops.result, distanceMeters: "$param.tram" },
      },
      {
        id: "nearParks",
        tool: "spatial_filter",
        args: { result: buildings.result, other: "$step.parks" },
      },
      {
        id: "outsideRail",
        tool: "spatial_filter",
        args: { result: "$step.nearParks", other: "$step.rails", invert: true },
      },
      {
        id: "nearTram",
        tool: "spatial_filter",
        args: { result: "$step.outsideRail", other: "$step.stops" },
      },
      {
        id: "style",
        tool: "result_style",
        args: {
          result: "$step.nearTram",
          field: "heightMeters",
          breaks: [15, 30],
          colors: ["#63a36e", "#d0a74d", "#a94538"],
          unit: "m",
        },
      },
    ],
    output: "style",
  });
  const first = await call("recipe_run", { recipe: recipe.recipe });
  const same = await call("recipe_run", { recipe: recipe.recipe });
  assert.equal(first.result, same.result);
  assert.equal(same.reusedSteps, 7);
  assert.equal(first.execution.sourceBytes, 0);
  assert.equal(same.execution.sourceBytes, 0);
  const changed = await call("recipe_run", {
    recipe: recipe.recipe,
    parameters: { park: 500 },
  });
  assert.equal(changed.execution.sourceBytes, 0);
  assert.equal(changed.reusedSteps, 2);
  assert(changed.count >= first.count);
  const report = {
    scope:
      "Retained geometry intersecting the rehearsal rectangle; buffers have straight-line distance. All retained rail classes are included deliberately to replay the trace. Boundary sources outside rehearsal coverage are unavailable. No real-world access/safety claim.",
    counts: {
      parks: parks.count,
      railways: rails.count,
      tramStops: stops.count,
      buildings: buildings.count,
      selected: first.count,
      park500m: changed.count,
    },
    firstSteps: first.steps,
    changedSteps: changed.steps,
    timings,
  };
  await Bun.write(
    "/tmp/atlas-recipes-pair.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  runtime.clear();
  readers.forEach((r) => r.dispose());
}
