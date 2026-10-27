import { test, expect } from "bun:test";
import area from "@turf/area";
import intersect from "@turf/intersect";
import inside from "@turf/boolean-point-in-polygon";
import distance from "@turf/distance";
import type { Feature, Point, Polygon } from "geojson";
import {
  fc,
  rect,
  boundsOf,
  type Surface,
} from "../packages/spatial/src/index";
import {
  constructShape,
  distanceBands,
} from "../packages/spatial/src/construction";
const signal = () => new AbortController().signal;
const point = (x = 16.38, y = 48.22): Feature<Point> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [x, y] },
});

test("circle radius is metric; direct bands are disjoint annuli, not grid cells", async () => {
  const origin = point();
  const bands = await distanceBands(
    { distancesMeters: [100, 250, 500], toleranceMeters: 0.1 },
    fc([origin]),
    signal(),
  );
  expect(bands.collection.features.length).toBe(3);
  let lastRadius = 0;
  for (const f of bands.collection.features as Surface[]) {
    const radius = f.properties!.toMeters;
    expect(
      Math.abs(area(f) / (Math.PI * (radius ** 2 - lastRadius ** 2)) - 1),
    ).toBeLessThan(0.01);
    const g =
      f.geometry.type === "Polygon"
        ? f.geometry.coordinates
        : f.geometry.coordinates[0]!;
    for (const p of g[0]!)
      expect(
        Math.abs(distance(origin, p, { units: "meters" }) - radius),
      ).toBeLessThan(0.2);
    lastRadius = radius;
  }
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++) {
      const overlap = intersect(
        fc([
          bands.collection.features[a] as Surface,
          bands.collection.features[b] as Surface,
        ]),
      );
      expect(overlap ? area(overlap) : 0).toBeLessThan(0.01);
    }
});
test("area interiors excluded; courtyard holes remain meaningful and bands clip after buffering", async () => {
  const source = rect([16.37, 48.21, 16.39, 48.23]) as Feature<Polygon>;
  source.geometry.coordinates.push(
    (rect([16.378, 48.218, 16.382, 48.222]).geometry as Polygon)
      .coordinates[0]!,
  );
  const r = await distanceBands(
    { distancesMeters: [50, 100], bounds: [16.369, 48.209, 16.391, 48.231] },
    fc([source]),
    signal(),
  );
  const shapes = r.collection.features as Surface[];
  expect(shapes.some((f) => inside([16.371, 48.22], f))).toBe(false); // water
  expect(shapes.some((f) => inside([16.38, 48.2181], f))).toBe(true); // land near courtyard bank
  expect(shapes.some((f) => inside([16.38, 48.22], f))).toBe(false); // farther inland
  for (const f of shapes) {
    const b = boundsOf(f);
    expect(b[0]).toBeGreaterThanOrEqual(16.369);
    expect(b[2]).toBeLessThanOrEqual(16.391);
  }
  // Water extends beyond the clipping box. There must be no band at that artificial edge.
  const clipped = await distanceBands(
    { distancesMeters: [50], bounds: [16.373, 48.213, 16.375, 48.215] },
    fc([source]),
    signal(),
  );
  expect(clipped.collection.features.length).toBe(0);
});
test("overlapping inputs dissolve; empty input and source inclusion have defined behavior", async () => {
  const r = await distanceBands(
    { distancesMeters: [100] },
    fc([point(), point(16.3801)]),
    signal(),
  );
  expect(r.collection.features.length).toBe(1);
  expect(area(r.collection)).toBeLessThan(2 * Math.PI * 100 ** 2);
  expect(
    (await distanceBands({ distancesMeters: [100] }, fc([]), signal()))
      .collection.features.length,
  ).toBe(0);
  const s = rect([16.37, 48.21, 16.38, 48.22]);
  const included = await distanceBands(
    { distancesMeters: [50], excludeSource: false },
    fc([s]),
    signal(),
  );
  expect(
    inside([16.375, 48.215], included.collection.features[0] as Surface),
  ).toBe(true);
});
test("shape constructors close rings, validate topology and use corridor half-width", async () => {
  const rectangle = await constructShape(
    { kind: "rectangle", bounds: [0, 0, 0.01, 0.01] },
    undefined,
    signal(),
  );
  expect(rectangle.collection.features.length).toBe(1);
  const authored = await constructShape(
    {
      kind: "polygon",
      rings: [
        [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0, 0.01],
        ],
        [
          [0.002, 0.002],
          [0.004, 0.002],
          [0.004, 0.004],
          [0.002, 0.004],
        ],
      ],
    },
    undefined,
    signal(),
  );
  expect(
    inside([0.003, 0.003], authored.collection.features[0] as Surface),
  ).toBe(false);
  for (const rings of [
    [
      [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, 0],
      ],
    ],
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 3],
      ],
    ],
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [
        [0.5, 0.5],
        [1.5, 0.5],
        [1.5, 0.6],
        [0.5, 0.6],
      ],
    ],
  ])
    await expect(
      constructShape({ kind: "polygon", rings }, undefined, signal()),
    ).rejects.toThrow();
  const line: Feature = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
    },
  };
  const corridor = await constructShape(
    { kind: "corridor", radiusMeters: 100 },
    fc([line]),
    signal(),
  );
  expect(
    inside([0.005, 0.0008], corridor.collection.features[0] as Surface),
  ).toBe(true);
  expect(
    inside([0.005, 0.0012], corridor.collection.features[0] as Surface),
  ).toBe(false);
  await expect(
    constructShape(
      { kind: "corridor", radiusMeters: 100 },
      fc([point()]),
      signal(),
    ),
  ).rejects.toThrow("only lines");
});
test("invalid parameters and cancellation fail without partial geometry", async () => {
  for (const distancesMeters of [[100, 50], [100, 100], [0], [Infinity]])
    await expect(
      distanceBands({ distancesMeters }, fc([point()]), signal()),
    ).rejects.toThrow();
  await expect(
    constructShape(
      { kind: "circle", center: [181, 0], radiusMeters: 100 },
      undefined,
      signal(),
    ),
  ).rejects.toThrow();
  const c = new AbortController();
  await expect(
    distanceBands({ distancesMeters: [100] }, fc([point()]), c.signal, () =>
      c.abort(),
    ),
  ).rejects.toThrow();
});
