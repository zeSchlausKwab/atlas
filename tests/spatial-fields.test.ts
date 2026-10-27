import { test, expect } from "bun:test";
import area from "@turf/area";
import inside from "@turf/boolean-point-in-polygon";
import intersect from "@turf/intersect";
import type { Feature, Polygon } from "geojson";
import {
  createField,
  fieldContours,
  type SampledField,
} from "../packages/spatial/src/fields";
import {
  fc,
  rect,
  type Bounds,
  type Surface,
} from "../packages/spatial/src/index";
const signal = () => new AbortController().signal;
const point: Feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [0, 0] },
};
const bounds: Bounds = [-0.01, -0.01, 0.01, 0.01];
const create = (features = [point], cellMeters = 25) =>
  createField({ kind: "distance", bounds, cellMeters }, fc(features), signal());
test("distance fields sample continuous geometry; contour rings approximate analytic distance", async () => {
  const f = await create();
  expect(f.description.spacingMeters.every((v) => v <= 25)).toBe(true);
  const out = await fieldContours(
    f,
    { thresholds: [0, 100, 250, 500] },
    signal(),
  );
  expect(out.collection.features.length).toBe(3);
  let previous = 0;
  for (const feature of out.collection.features) {
    const radius = feature.properties!.upper;
    expect(
      Math.abs(area(feature) / (Math.PI * (radius ** 2 - previous ** 2)) - 1),
    ).toBeLessThan(0.04);
    previous = radius;
  }
  expect(inside([0, 0], out.collection.features[2] as Surface)).toBe(false); // hole preserved
  for (let i = 1; i < 3; i++) {
    const overlap = intersect(
      fc([
        out.collection.features[i - 1] as Surface,
        out.collection.features[i] as Surface,
      ]),
    );
    expect(overlap ? area(overlap) : 0).toBeLessThan(0.001);
  }
});
test("distance to polygon interior is zero, hole and line distances stay outside", async () => {
  const shape = rect([-0.008, -0.008, 0.008, 0.008]) as Feature<Polygon>;
  shape.geometry.coordinates.push(
    (rect([-0.003, -0.003, 0.003, 0.003]).geometry as Polygon).coordinates[0]!,
  );
  const f = await create([shape]);
  expect(f.description.min).toBe(0);
  expect(
    f.values[Math.floor(f.ny / 2) * f.nx + Math.floor(f.nx / 2)],
  ).toBeGreaterThan(300);
  const line: Feature = {
    ...point,
    geometry: {
      type: "LineString",
      coordinates: [
        [-0.02, 0],
        [0.02, 0],
      ],
    },
  };
  const l = await create([line]);
  expect(l.values[0]).toBeCloseTo(1111.95, 1);
});
test("contour lines do not include artificial field border; bands cover only requested range", async () => {
  const f = await create([], 200);
  // A known analytical ramp, eastward from zero to 100: vertical isolines.
  for (let y = 0; y < f.ny; y++)
    for (let x = 0; x < f.nx; x++)
      f.values[y * f.nx + x] = (100 * x) / (f.nx - 1);
  const lines = await fieldContours(
    f,
    { thresholds: [25, 50, 75], mode: "lines" },
    signal(),
  );
  expect(lines.collection.features.length).toBe(3);
  for (const feature of lines.collection.features) {
    expect(feature.geometry.type).toBe("MultiLineString");
    if (feature.geometry.type !== "MultiLineString") throw new Error();
    expect(feature.geometry.coordinates.length).toBe(1);
    const coords = feature.geometry.coordinates[0]!;
    for (const p of coords)
      expect(p[0]).toBeCloseTo(
        -0.01 + (0.02 * feature.properties!.value) / 100,
        10,
      );
    expect(Math.abs(coords.at(-1)![1]! - coords[0]![1]!)).toBeCloseTo(0.02, 10);
  }
  const bands = await fieldContours(f, { thresholds: [25, 75] }, signal());
  expect(area(bands.collection) / area(rect(bounds))).toBeCloseTo(0.5, 6);
  f.values.fill(50);
  expect(
    (await fieldContours(f, { thresholds: [25], mode: "lines" }, signal()))
      .collection.features.length,
  ).toBe(0);
  expect(
    area(
      (await fieldContours(f, { thresholds: [25, 75] }, signal())).collection,
    ),
  ).toBeCloseTo(area(rect(bounds)), 2);
});
test("Gaussian density has stated units and mass; missing weights and empty inputs are unknown", async () => {
  const f = await createField(
    { kind: "density", bounds, cellMeters: 15, bandwidthMeters: 100 },
    fc([point]),
    signal(),
  );
  const mass =
    (f.values.reduce((a, b) => a + b, 0) *
      f.description.spacingMeters[0] *
      f.description.spacingMeters[1]) /
    1e6;
  expect(mass).toBeCloseTo(1, 3);
  expect(f.description.unit).toBe("retained points/km²");
  const missing = await createField(
    {
      kind: "density",
      bounds,
      cellMeters: 50,
      bandwidthMeters: 100,
      weightField: "population",
    },
    fc([point]),
    signal(),
  );
  expect(missing.description.unknownWeights).toBe(1);
  expect(missing.description.knownSamples).toBe(0);
  expect(missing.description.min).toBeNull();
  expect(
    (await fieldContours(missing, { thresholds: [0, 100] }, signal()))
      .collection.features.length,
  ).toBe(0);
  const empty = await create([]);
  expect(empty.description.unknownSamples).toBe(empty.values.length);
  expect(
    (await fieldContours(empty, { thresholds: [0], mode: "lines" }, signal()))
      .collection.features.length,
  ).toBe(0);
  await expect(
    createField(
      { kind: "density", bounds, cellMeters: 100, bandwidthMeters: 100 },
      fc([rect(bounds)]),
      signal(),
    ),
  ).rejects.toThrow("requires points");
});
test("field creation is cancellable; thresholds and geographic metric limits validate", async () => {
  const c = new AbortController();
  await expect(
    createField(
      { kind: "distance", bounds, cellMeters: 10 },
      fc([point]),
      c.signal,
      () => c.abort(),
    ),
  ).rejects.toThrow();
  const f = await create();
  await expect(
    fieldContours(f, { thresholds: [1, 1] }, signal()),
  ).rejects.toThrow();
  await expect(
    fieldContours(f, { thresholds: [1] }, signal()),
  ).rejects.toThrow();
  await expect(
    createField(
      { kind: "distance", bounds: [-10, 20, 10, 70], cellMeters: 100 },
      fc([point]),
      signal(),
    ),
  ).rejects.toThrow("local planar");
});
