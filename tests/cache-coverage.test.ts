import { expect, test } from "bun:test";
import { cacheCoverage } from "../packages/renderer/src/cache-coverage";
import type { TileView } from "../packages/renderer/src/tile-presentation";
const view: TileView = {
  zoom: 1,
  bounds: [0, 0, 0.49, 0.49],
  layers: ["water", "buildings"],
  complete: true,
  blocks: ["water", "buildings"].map((l) => ({
    key: `tile/${l}/1/0/0`,
    z: 1,
    x: 0,
    y: 0,
  })),
};
test("cache coverage counts actual selected payloads at the target zoom", () => {
  expect(cacheCoverage(view, (k) => k.includes("water"))[0]).toMatchObject({
    cached: 1,
    total: 2,
    fraction: 0.5,
  });
  expect(cacheCoverage(view, () => true)[0]?.fraction).toBe(1);
  expect(cacheCoverage(view, () => false)[0]?.fraction).toBe(0);
  expect(
    cacheCoverage({ ...view, blocks: [view.blocks[0]!] }, () => true)[0]
      ?.fraction,
  ).toBe(1);
  expect(cacheCoverage({ ...view, blocks: [] }, () => true)[0]).toMatchObject({
    total: 0,
    fraction: 0,
  });
});
test("unknown directory coverage is not shown as fully cached or empty", () => {
  expect(
    cacheCoverage({ ...view, complete: false }, () => true)[0]?.fraction,
  ).toBeNull();
  expect(cacheCoverage({ ...view, layers: [] }, () => true)).toEqual([]);
  expect(
    cacheCoverage(
      { ...view, blocks: [{ key: "tile/water/0/0/0", z: 0, x: 0, y: 0 }] },
      () => true,
    )[0]?.total,
  ).toBe(0);
});
