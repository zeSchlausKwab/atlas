import { expect, test } from "bun:test";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";
import { fc, rect } from "../packages/spatial/src/index";
import { AnalysisRecipes, canonical } from "../packages/chat/src/recipes";
const signal = () => new AbortController().signal;

test("explicit water mask removes other water; checks detect overlap and clipped bands stay disjoint", async () => {
  const { reader } = await workspaceFixture();
  const runtime = new ChatDataRuntime([reader]);
  const source = runtime.results.save(fc([rect([16, 48, 16.001, 48.005])]), {});
  const mask = runtime.results.save(
    fc([rect([16.0015, 48, 16.003, 48.005])]),
    {},
  );
  const args = {
    result: source.result,
    distancesMeters: [100, 250, 500],
    bounds: [15.999, 47.999, 16.008, 48.006],
  };
  const unmasked = await runtime.invoke("spatial_bands", args, signal());
  const failed = await runtime.invoke(
    "result_check",
    { result: unmasked.result, excludeResult: mask.result },
    signal(),
  );
  expect(failed.checks.passed).toBe(false);
  expect(failed.checks.excludedOverlapM2).toBeGreaterThan(1);
  const masked = await runtime.invoke(
    "spatial_bands",
    { ...args, excludeResult: mask.result },
    signal(),
  );
  const checked = await runtime.invoke(
    "result_check",
    {
      result: masked.result,
      excludeResult: mask.result,
      disjoint: true,
      bounds: args.bounds,
    },
    signal(),
  );
  expect(checked.checks.passed).toBe(true);
  expect(checked.checks.polygonCount).toBe(3);
  expect(checked.checks.areaM2).toBeLessThan(failed.checks.areaM2);
  reader.dispose();
  runtime.clear();
});

test("result pages normalize workspace locations and derived geometry; merges dedupe and themes preserve unknowns", async () => {
  const { reader } = await workspaceFixture();
  const runtime = new ChatDataRuntime([reader]);
  const p = await runtime.invoke(
    "workspace_prepare",
    { bounds: taskBounds, families: ["locations"], geometry: true },
    signal(),
  );
  const q = await runtime.invoke(
    "workspace_query",
    { workspace: p.workspace },
    signal(),
  );
  const page = await runtime.invoke(
    "result_rows",
    { result: q.result, limit: 1 },
    signal(),
  );
  expect(page.rows[0].geometryType).toBe("Point");
  expect(page.nextOffset).toBe(1);
  const merged = await runtime.invoke(
    "result_merge",
    { results: [q.result, q.result] },
    signal(),
  );
  expect(merged.count).toBe(q.count);
  const derived = await runtime.invoke(
    "workspace_result",
    { result: merged.result, limit: 1 },
    signal(),
  );
  expect(derived.rows[0].id).toBe(page.rows[0].id);
  const input = runtime.results.save(
    fc(
      [0, 10, 20, null].map((v, i) => ({
        type: "Feature",
        id: String(i),
        geometry: { type: "Point", coordinates: [16, 48] },
        properties: { height: v, name: "B" + i },
      })),
    ),
    {},
  );
  const styled = await runtime.invoke(
    "result_style",
    {
      result: input.result,
      field: "height",
      breaks: [10, 20],
      colors: ["#000000", "#333333", "#ffffff"],
      labelField: "name",
      unit: "m",
    },
    signal(),
  );
  expect(styled.counts).toEqual([1, 1, 1]);
  expect(styled.unknown).toBe(1);
  expect(styled.legend.length).toBe(4);
  expect(styled.style.colorProperty).toBe("atlasColor");
  expect(
    (await runtime.resolve(styled.result)).collection.features[3]!.properties!
      .atlasColor,
  ).toBe("#8a918b");
  reader.dispose();
  runtime.clear();
});

test("recipe reruns only changed steps, reads no source bytes, and rejects invalid parameters and failed checks", async () => {
  const { reader } = await workspaceFixture();
  const runtime = new ChatDataRuntime([reader]);
  const origin = runtime.results.save(
    fc([
      {
        type: "Feature",
        id: "park",
        geometry: { type: "Point", coordinates: [16, 48] },
        properties: {},
      },
    ]),
    {},
  );
  const buildings = runtime.results.save(
    fc(
      [
        rect([16.001, 48, 16.0011, 48.0001]),
        rect([16.004, 48, 16.0041, 48.0001]),
      ].map((f, i) => ({ ...f, id: String(i) })),
    ),
    {},
  );
  const recipe = await runtime.invoke(
    "recipe_define",
    {
      title: "Park access",
      parameters: { distance: { value: 100, min: 50, max: 500, unit: "m" } },
      steps: [
        {
          id: "measure",
          tool: "spatial_measure",
          args: { result: buildings.result },
        },
        {
          id: "buffer",
          tool: "spatial_buffer",
          args: { result: origin.result, distanceMeters: "$param.distance" },
        },
        {
          id: "selected",
          tool: "spatial_filter",
          args: { result: "$step.measure", other: "$step.buffer" },
        },
        {
          id: "styled",
          tool: "result_style",
          args: { result: "$step.selected", colors: ["#345d48"] },
        },
      ],
      output: "styled",
    },
    signal(),
  );
  const first = await runtime.invoke(
    "recipe_run",
    { recipe: recipe.recipe },
    signal(),
  );
  expect(first.count).toBe(1);
  expect(first.reusedSteps).toBe(0);
  const same = await runtime.invoke(
    "recipe_run",
    { recipe: recipe.recipe },
    signal(),
  );
  expect(same.reusedSteps).toBe(4);
  expect(same.result).toBe(first.result);
  const changed = await runtime.invoke(
    "recipe_run",
    { recipe: recipe.recipe, parameters: { distance: 400 } },
    signal(),
  );
  expect(changed.count).toBe(2);
  expect(changed.reusedSteps).toBe(1);
  expect(changed.execution.sourceBytes).toBe(0);
  await expect(
    runtime.invoke(
      "recipe_run",
      { recipe: recipe.recipe, parameters: { distance: -1 } },
      signal(),
    ),
  ).rejects.toThrow("out of range");
  const bad = await runtime.invoke(
    "recipe_define",
    {
      title: "Bad check",
      parameters: {},
      steps: [
        {
          id: "check",
          tool: "result_check",
          args: { result: buildings.result, bounds: [0, 0, 1, 1] },
        },
      ],
      output: "check",
    },
    signal(),
  );
  await expect(
    runtime.invoke("recipe_run", { recipe: bad.recipe }, signal()),
  ).rejects.toThrow("check failed");
  runtime.clear();
  await expect(
    runtime.invoke("recipe_run", { recipe: recipe.recipe }, signal()),
  ).rejects.toThrow("Unknown recipe");
  reader.dispose();
});

test("recipes reject arbitrary code, forward references and aborted partial results", async () => {
  const recipes = new AnalysisRecipes();
  expect(() =>
    recipes.define({
      title: "Bad",
      parameters: {},
      steps: [{ id: "a", tool: "run_code", args: {} }],
      output: "a",
    }),
  ).toThrow("unsupported");
  expect(() =>
    recipes.define({
      title: "Bad",
      parameters: {},
      steps: [
        { id: "a", tool: "spatial_buffer", args: { result: "$step.later" } },
      ],
      output: "a",
    }),
  ).toThrow("forward");
  const r = recipes.define({
      title: "Cancel",
      parameters: {},
      steps: [
        { id: "a", tool: "spatial_measure", args: { result: "geo-one" } },
      ],
      output: "a",
    }),
    abort = new AbortController();
  let calls = 0;
  await expect(
    recipes.run(
      r.recipe,
      {},
      async () => {
        calls++;
        abort.abort();
        return { result: "geo-partial" };
      },
      abort.signal,
      () => {},
    ),
  ).rejects.toThrow();
  await recipes.run(
    r.recipe,
    {},
    async () => {
      calls++;
      return { result: "geo-ok" };
    },
    signal(),
    () => {},
  );
  expect(calls).toBe(2);
});

test("stable keys ignore property order and JSON-absent optional fields", () => {
  expect(canonical({ z: 1, a: { v: 2, absent: undefined } })).toBe(
    canonical({ a: { v: 2 }, z: 1 }),
  );
});
