import { test, expect } from "bun:test";
import {
  PREPARATION_PRESETS,
  preparationPreset,
} from "../packages/provisioning/src/presets";
import {
  estimatePreparation,
  candidateTileCount,
} from "../packages/provisioning/src/estimate";
import {
  hostPreparationSpace,
  NO_SIZE_LIMIT,
  BUILD_DISK_FLOOR,
} from "../packages/provisioning/src/capacity";
import {
  validatePolygon,
  inside,
  type Polygon,
} from "../packages/offline/src/geometry";
import {
  WORLD_SOURCE,
  importBounds,
} from "../packages/provisioning/src/global-source";
import {
  validateSelectionScope,
  type PackageSelection,
} from "../packages/provisioning/src/selection";
import { planCachedBuild } from "../packages/provisioning/src/cached-build";
import { isWorldSelection } from "../packages/provisioning/src/world-selection";
const world: Polygon = [
  [-180, -85],
  [180, -85],
  [180, 85],
  [-180, 85],
];
const selection: PackageSelection = {
  snapshot: WORLD_SOURCE.snapshot,
  name: "World information",
  polygon: world,
  minZoom: 0,
  maxZoom: 6,
  layers: ["water"],
  placeNames: true,
  streetNames: false,
  pois: false,
  profiles: [],
  search: false,
  reverse: false,
  peaks: false,
  featureKinds: ["boundaries"],
  boundaryMaxAdminLevel: 10,
  paddingCells: 0,
  maxBytes: NO_SIZE_LIMIT,
};
const planet = { kind: "planet" as const, bytes: 80 * 1024 ** 3 };
test("world selection validates and schedules disk-backed work without enumerating high-zoom tiles", () => {
  for (const p of [
    world,
    [...world].reverse(),
    [...world.slice(1), world[0]!],
  ]) {
    validatePolygon(p);
    expect(isWorldSelection(p)).toBe(true);
    expect(inside([179.9, 0], p)).toBe(true);
    expect(inside([-179.9, 0], p)).toBe(true);
  }
  validateSelectionScope(selection, WORLD_SOURCE);
  expect(importBounds({ ...selection, maxSourceBytes: NO_SIZE_LIMIT })).toEqual(
    [-180, -85, 180, 85],
  );
  expect(planCachedBuild({ ...selection, maxZoom: 16 }).partitioned).toBe(true);
  expect(candidateTileCount({ ...selection, maxZoom: 16 })).toBeGreaterThan(
    5e9,
  );
  expect(() =>
    validatePolygon([
      [179, 0],
      [-179, 0],
      [179, 1],
    ]),
  ).toThrow("Date-line");
  expect(() =>
    validatePolygon([world[0]!, world[2]!, world[1]!, world[3]!]),
  ).toThrow();
});
test("world recipes separate exact administrative data from display-only geometry", () => {
  expect(new Set(PREPARATION_PRESETS.map((p) => p.id)).size).toBe(
    PREPARATION_PRESETS.length,
  );
  const info = preparationPreset("world-admin")!,
    geometry = preparationPreset("world-geometry")!;
  expect(info.fields).toContain("feature-boundaries");
  expect(info.fields).toContain("places");
  expect(info.fields).not.toContain("feature-objects");
  expect(info.fields).not.toContain("layer-buildings");
  expect(info.boundaryMaxAdminLevel).toBe(10);
  expect(info.maxZoom).toBe(6);
  expect(geometry.fields).toHaveLength(7);
  expect(
    (geometry.fields as string[]).every(
      (key) => key.startsWith("layer-") || key === "ocean",
    ),
  ).toBe(true);
  expect(geometry.maxZoom).toBe(16);
});
test("modeled ranges distinguish zoomed tiles, fixed-detail boundaries, query families and reused sources", () => {
  const estimate = (s: PackageSelection) => estimatePreparation(s, planet);
  const compact = estimate(selection),
    detailed = estimate({ ...selection, maxZoom: 16 });
  expect(detailed.output.high).toBeGreaterThan(compact.output.high);
  const boundary = (e: ReturnType<typeof estimate>) =>
    e.components.find((c) => c.name.startsWith("Administrative"))!.bytes;
  expect(boundary(compact)).toEqual(boundary(detailed));
  expect(
    boundary(estimate({ ...selection, boundaryMaxAdminLevel: 2 })).high,
  ).toBeLessThan(boundary(compact).high);
  for (const extra of [
    { profiles: ["walking" as const] },
    { search: true },
    { featureKinds: ["boundaries" as const, "objects" as const] },
    { layers: ["water" as const, "buildings" as const] },
  ])
    expect(estimate({ ...selection, ...extra }).output.high).toBeGreaterThan(
      compact.output.high,
    );
  const download = estimatePreparation(selection, {
    ...planet,
    download: true,
  });
  expect(compact.downloadBytes).toBe(0);
  expect(download.downloadBytes).toBe(planet.bytes);
  expect(download.output).toEqual(compact.output);
  expect(compact.temporary.high).toBeGreaterThan(compact.output.high);
  expect(estimate({ ...selection, minZoom: 4 }).output.high).toBeLessThan(
    compact.output.high,
  );
  const small = estimate({
    ...selection,
    polygon: [
      [10, 45],
      [11, 45],
      [11, 46],
      [10, 46],
    ],
  });
  expect(small.output.high).toBeLessThan(compact.output.high);
  const needed = hostPreparationSpace(NO_SIZE_LIMIT, {
    cached: true,
    selection,
    estimateSource: planet,
  });
  expect(needed).toBe(
    BUILD_DISK_FLOOR + compact.output.high + compact.temporary.high,
  );
  expect(
    hostPreparationSpace(NO_SIZE_LIMIT, {
      cached: true,
      partitioned: true,
      resume: true,
      extractedBytes: 30 * 1024 ** 3,
      selection,
      estimateSource: planet,
    }),
  ).toBeLessThan(needed);
});
test("regional and existing Atlas uncertainty is explicit; invalid depth is rejected", () => {
  expect(
    estimatePreparation(selection, {
      kind: "regional",
      bytes: planet.bytes,
    }).notes.join(" "),
  ).toContain("no coverage bounds");
  const atlas = estimatePreparation(selection, { kind: "atlas", bytes: 10000 });
  expect(atlas.output).toEqual({ low: 0, high: 64 * 1024 ** 2 + 20000 });
  expect(atlas.temporary.high).toBeGreaterThanOrEqual(atlas.temporary.low);
  expect(atlas.notes.join(" ")).toContain("entire archive");
  for (const depth of [0, 13, -1, 2.5, NaN])
    expect(() =>
      validateSelectionScope(
        { ...selection, boundaryMaxAdminLevel: depth },
        WORLD_SOURCE,
      ),
    ).toThrow("Administrative depth");
  expect(() =>
    validateSelectionScope({ ...selection, featureKinds: [] }, WORLD_SOURCE),
  ).toThrow("requires boundary");
});
