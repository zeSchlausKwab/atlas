import { expect, test } from "bun:test";
import type { Feature, Polygon, FeatureCollection } from "geojson";
import {
  spatialOperation,
  fc,
  rect,
  property,
  type SpatialInput,
} from "../packages/spatial/src/index";
import {
  prepareChart,
  filterRows,
  normalizeRows,
  summary,
} from "../packages/chat/src/analysis";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { workspaceFixture, taskBounds } from "./helpers/workspace-fixture";
const point = (
  x: number,
  y: number,
  id = "point",
  props: Record<string, unknown> = {},
): Feature => ({
  type: "Feature",
  id,
  properties: { name: id, ...props },
  geometry: { type: "Point", coordinates: [x, y] },
});
const line = (coords: number[][], id = "line"): Feature => ({
  type: "Feature",
  id,
  properties: { name: id },
  geometry: { type: "LineString", coordinates: coords },
});
const run = (input: SpatialInput, source: Feature[], target?: Feature[]) =>
  spatialOperation(
    input,
    fc(source),
    target ? fc(target) : undefined,
    new AbortController().signal,
  );
const hole = (): Feature<Polygon> => ({
  ...rect([0, 0, 0.02, 0.02]),
  id: "lake",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [0.02, 0],
        [0.02, 0.02],
        [0, 0.02],
        [0, 0],
      ],
      [
        [0.005, 0.005],
        [0.015, 0.005],
        [0.015, 0.015],
        [0.005, 0.015],
        [0.005, 0.005],
      ],
    ],
  },
});

test("measure differentiates polygon area/perimeter, line length, points and holes", async () => {
  const r = await run({ operation: "measure" }, [
    hole(),
    line([
      [0, 0],
      [0.01, 0],
    ]),
    point(0, 0),
  ]);
  const p = r.collection.features.map((f) => f.properties!);
  expect(p[0]!.areaM2).toBeGreaterThan(3_700_000);
  expect(p[0]!.areaM2).toBeLessThan(3_720_000);
  expect(p[0]!.perimeterM).toBeGreaterThan(13_300);
  expect(p[0]!.lengthM).toBeNull();
  expect(p[1]!.lengthM).toBeCloseTo(1111.9508, 2);
  expect(p[1]!.areaM2).toBeNull();
  expect(p[2]!.lengthM).toBeNull();
  expect(p[2]!.areaM2).toBeNull();
});
test("representative point stays out of polygon hole while centroid is explicit", async () => {
  const r = await run({ operation: "points" }, [hole()]);
  const inside = await run(
    { operation: "filter", mode: "representative_within" },
    r.collection.features,
    [hole()],
  );
  expect(inside.collection.features).toHaveLength(1);
  const c = await run({ operation: "points", mode: "centroid" }, [hole()]);
  expect(
    (
      await run(
        { operation: "filter", mode: "representative_within" },
        c.collection.features,
        [hole()],
      )
    ).collection.features,
  ).toHaveLength(0);
});
test("buffers use metres and retain source attributes; union removes overlap", async () => {
  const b = await run({ operation: "buffer", distanceMeters: 100 }, [
    point(16, 48, "a"),
    point(16, 48, "b"),
  ]);
  expect(b.collection.features[0]!.properties!.name).toBe("a");
  const measured = await run({ operation: "measure" }, b.collection.features);
  expect(measured.collection.features[0]!.properties!.areaM2).toBeGreaterThan(
    31000,
  );
  const u = await run(
    { operation: "overlay", mode: "union" },
    b.collection.features,
  );
  expect(u.collection.features).toHaveLength(1);
  expect(u.collection.features[0]!.properties!.areaM2).toBeLessThan(32000);
  await expect(
    run({ operation: "buffer", distanceMeters: -1 }, [point(0, 0)]),
  ).rejects.toThrow("positive");
});
test("overlay respects holes, disjoint inputs and difference semantics", async () => {
  const island = rect([0.007, 0.007, 0.013, 0.013]);
  expect(
    (
      await run(
        { operation: "overlay", mode: "intersection" },
        [hole()],
        [island],
      )
    ).collection.features,
  ).toHaveLength(0);
  expect(
    (
      await run(
        { operation: "overlay", mode: "difference" },
        [island],
        [rect([0, 0, 0.02, 0.02])],
      )
    ).collection.features,
  ).toHaveLength(0);
  await expect(
    run({ operation: "overlay", mode: "difference" }, [island]),
  ).rejects.toThrow("another result");
  await expect(
    run({ operation: "overlay", mode: "union" }, [point(0, 0)]),
  ).rejects.toThrow("Polygon");
});
test("clip cuts line length before measuring and removes outside points", async () => {
  const r = await run({ operation: "clip", bounds: [0, -0.01, 0.01, 0.01] }, [
    line([
      [-0.01, 0],
      [0.02, 0],
    ]),
    point(0.03, 0),
  ]);
  expect(r.collection.features).toHaveLength(1);
  const m = await run({ operation: "measure" }, r.collection.features);
  expect(m.collection.features[0]!.properties!.lengthM).toBeCloseTo(
    1111.9508,
    2,
  );
});
test("nearest uses full target line, radius, polygon interiors/holes, ties and unknowns", async () => {
  const r = await run(
    { operation: "nearest", maxDistanceMeters: 200 },
    [point(0.005, 0.001, "origin"), point(1, 1, "far")],
    [
      line(
        [
          [0, 0],
          [0.01, 0],
        ],
        "rail",
      ),
      line(
        [
          [0, 0],
          [0.01, 0],
        ],
        "rail-z",
      ),
    ],
  );
  expect(r.summary.matched).toBe(1);
  const p = r.collection.features[0]!.properties!;
  expect(p.nearestId).toBe("rail");
  expect(p.distanceM).toBeCloseTo(111.195, 1);
  expect(p.nearestPoint[0]).toBeCloseTo(0.005, 6);
  expect(r.collection.features[1]!.properties!.distanceM).toBeNull();
  const inside = await run(
    { operation: "nearest", maxDistanceMeters: 1000 },
    [point(0.001, 0.001), point(0.01, 0.01)],
    [hole()],
  );
  expect(inside.collection.features[0]!.properties!.distanceM).toBe(0);
  expect(inside.collection.features[1]!.properties!.distanceM).toBeGreaterThan(
    500,
  );
});
test("joins count intersections, include touches, preserve zero and exclude polygon holes", async () => {
  const p1 = point(0.002, 0.002, "cafe");
  p1.properties!.value = 0;
  const p2 = point(0.02, 0.01, "edge");
  p2.properties!.value = null;
  const r = await run(
    { operation: "join", field: "value" },
    [hole()],
    [p1, p2, point(0.01, 0.01, "hole")],
  );
  expect(r.collection.features[0]!.properties).toMatchObject({
    matchCount: 2,
    knownCount: 1,
    unknownCount: 1,
    sum: 0,
    mean: 0,
  });
  const outer = await run(
    { operation: "filter", invert: true },
    [p1, p2, point(0.01, 0.01, "hole")],
    [hole()],
  );
  expect(outer.collection.features.map((f) => f.id)).toEqual(["hole"]);
});
test("grid assigns boundary points once, includes empty cells and separates unknown from zero", async () => {
  const zero = point(0, 0, "zero"),
    unknown = point(0.01, 0.01, "unknown");
  zero.properties!.n = 0;
  const r = await run(
    {
      operation: "grid",
      bounds: [0, 0, 0.01, 0.01],
      cellMeters: 500,
      field: "n",
    },
    [zero, unknown, point(0.02, 0.02, "outside")],
  );
  expect(r.summary).toMatchObject({
    assigned: 2,
    outside: 1,
    columns: 3,
    rows: 3,
  });
  expect(r.collection.features).toHaveLength(9);
  expect(
    r.collection.features.reduce((n, f) => n + f.properties!.count, 0),
  ).toBe(2);
  expect(r.collection.features[0]!.properties).toMatchObject({
    count: 1,
    sum: 0,
    unknownCount: 0,
  });
  expect(r.collection.features.at(-1)!.properties).toMatchObject({
    count: 1,
    sum: null,
    unknownCount: 1,
  });
});
test("filter handles derived properties and typed missing values; histograms retain exact membership", () => {
  const rows = normalizeRows([
    point(0, 0, "a"),
    point(0, 0, "b"),
    point(0, 0, "c"),
    point(0, 0, "d"),
  ]);
  rows.forEach((r, i) => (r.properties.n = [0, 10, 20, null][i]));
  expect(
    filterRows(rows, {
      where: [{ field: "n", op: "gte", value: 0 }],
      sort: { field: "n", direction: "desc" },
      limit: 2,
    }).rows.map((r) => r.id),
  ).toEqual(["c", "b"]);
  expect(() =>
    filterRows(rows, { where: [{ field: "n", op: "exists", value: "true" }] }),
  ).toThrow("wrong type");
  const chart = prepareChart(
    { title: "values", kind: "histogram", result: "r", field: "n", bins: 2 },
    rows,
    {},
  );
  expect(chart.bars!.map((b) => b.indexes)).toEqual([[0], [1, 2]]);
  expect(chart.unknownIndexes).toEqual([3]);
  expect(
    property({ tags: { "railway:track_ref": "1" } }, "tags.railway:track_ref"),
  ).toBe("1");
  expect(property({}, "__proto__.constructor")).toBeNull();
});
test("cancellation yields before publishing derived output", async () => {
  const abort = new AbortController();
  let progress = 0;
  await expect(
    spatialOperation(
      { operation: "measure" },
      fc(Array.from({ length: 1000 }, (_, i) => point(0, 0, String(i)))),
      undefined,
      abort.signal,
      () => {
        progress++;
        abort.abort();
      },
    ),
  ).rejects.toThrow();
  expect(progress).toBeGreaterThan(0);
});
test("cached source → spatial result → chart selection/inspection keeps attributes with zero new reads", async () => {
  let reads = 0;
  const { reader } = await workspaceFixture(taskBounds, "18", () => reads++),
    runtime = new ChatDataRuntime([reader]),
    signal = new AbortController().signal;
  const prepared: any = await runtime.invoke(
    "workspace_prepare",
    { bounds: taskBounds, families: ["buildings"], geometry: true },
    signal,
  );
  const queried: any = await runtime.invoke(
    "workspace_query",
    { workspace: prepared.workspace },
    signal,
  );
  const before = reads;
  const shapes = await runtime.resolve(queried.result);
  expect(shapes.collection.features[0]!.properties).toMatchObject({
    heightMeters: 18,
    tags: { height: "18" },
  });
  const measured: any = await runtime.invoke(
    "spatial_measure",
    { result: queried.result },
    signal,
  );
  expect(measured.execution.sourceBytes).toBe(0);
  const described: any = await runtime.invoke(
    "result_summary",
    { result: measured.result, field: "areaM2" },
    signal,
  );
  expect(described.statistics.mean).toBeGreaterThan(0);
  const chart = runtime.chart({
    result: measured.result,
    title: "Areas",
    kind: "histogram",
    field: "areaM2",
  });
  expect(chart.bars![0]!.count).toBe(1);
  const selected = runtime.select(measured.result, chart.bars![0]!.indexes);
  const selectedShapes = await runtime.resolve(selected.result);
  expect(selectedShapes.collection.features[0]!.id).toBe("way/10");
  const inspected: any = await runtime.invoke(
    "feature_inspect",
    { result: selected.result, id: "way/10" },
    signal,
  );
  expect(inspected.properties.tags.height).toBe("18");
  expect(inspected.provenance.inputs).toHaveLength(1);
  expect(reads).toBe(before);
  runtime.clear();
  reader.dispose();
});

test("geometry type filtering survives transformations; numeric summaries stay concise", async () => {
  const rows = normalizeRows([
    point(0, 0),
    line([
      [0, 0],
      [0.01, 0],
    ]),
    hole(),
  ]);
  expect(
    filterRows(rows, {
      where: [{ field: "geometryType", op: "eq", value: "LineString" }],
    }).rows,
  ).toHaveLength(1);
  const converted = await run({ operation: "points" }, [hole()]);
  expect(converted.collection.features[0]!.properties!.geometryType).toBe(
    "Point",
  );
  const stats = summary(
    normalizeRows([point(0, 0, "a", { n: 1 }), point(1, 0, "b", { n: 2 })]),
    "n",
  );
  expect(stats.categories).toEqual([]);
  expect(stats.statistics!.sum).toBe(3);
});

test("hull and multiline measures support non-building geometries", async () => {
  const hull = await run({ operation: "hull" }, [
    point(0, 0),
    point(0.01, 0),
    point(0, 0.01),
  ]);
  expect(hull.collection.features).toHaveLength(1);
  expect(hull.collection.features[0]!.properties!.areaM2).toBeGreaterThan(
    600000,
  );
  expect(
    (await run({ operation: "hull" }, [point(0, 0), point(0.01, 0)])).collection
      .features,
  ).toHaveLength(0);
  const measure = await run({ operation: "measure" }, [
    {
      type: "Feature",
      properties: { railway: "tram" },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [0.01, 0],
          ],
          [
            [0, 0],
            [0, 0.01],
          ],
        ],
      },
    },
  ]);
  expect(measure.collection.features[0]!.properties!.lengthM).toBeCloseTo(
    2223.9016,
    2,
  );
});

test("scatterplots and tables keep source membership and separate unknown coordinates", () => {
  const rows = normalizeRows([
    point(0, 0, "zero", { x: 0, y: 0 }),
    point(1, 1, "unknown", { x: 5, y: null }),
    point(2, 2, "known", { x: 2, y: 4 }),
  ]);
  const chart = prepareChart(
    { result: "r", title: "Comparison", kind: "scatter", x: "x", y: "y" },
    rows,
    {},
  );
  expect(chart.points!.map((p) => p.index)).toEqual([0, 2]);
  expect(chart.unknownIndexes).toEqual([1]);
  const table = prepareChart(
    { result: "r", title: "Table", kind: "table", columns: ["x", "y"] },
    rows,
    {},
  );
  expect(table.rows![0]).toEqual({ index: 0, id: "zero", values: [0, 0] });
});

test("workspace geometry-type filters expose shapes and location anchors without new reads", async () => {
  let reads = 0;
  const { reader } = await workspaceFixture(taskBounds, "18", () => reads++);
  const runtime = new ChatDataRuntime([reader]);
  const signal = new AbortController().signal;
  try {
    const prepared = await runtime.invoke(
      "workspace_prepare",
      {
        bounds: taskBounds,
        families: ["buildings", "locations"],
        geometry: true,
      },
      signal,
    );
    const before = reads;
    const polys = await runtime.invoke(
      "workspace_query",
      {
        workspace: prepared.workspace,
        where: [{ field: "geometryType", op: "eq", value: "Polygon" }],
      },
      signal,
    );
    const points = await runtime.invoke(
      "workspace_query",
      {
        workspace: prepared.workspace,
        where: [{ field: "geometryType", op: "eq", value: "Point" }],
      },
      signal,
    );
    expect(polys.count).toBe(1);
    expect(points.count).toBe(3);
    expect(reads).toBe(before);
  } finally {
    runtime.clear();
    reader.dispose();
  }
});
