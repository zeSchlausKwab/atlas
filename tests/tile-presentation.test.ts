import { expect, test } from "bun:test";
import {
  TilePresentation,
  type RenderTile,
  type TileView,
} from "../packages/renderer/src/tile-presentation";
const tile = (
  z: number,
  x: number,
  y: number,
  layer = "buildings",
): RenderTile => ({ key: `tile/${layer}/${z}/${x}/${y}`, z, x, y });
const parent = tile(14, 8192, 8192),
  children = [
    tile(15, 16384, 16384),
    tile(15, 16385, 16384),
    tile(15, 16384, 16385),
    tile(15, 16385, 16385),
  ];
const view = (
  zoom: number,
  blocks: RenderTile[],
  complete = true,
): TileView => ({
  zoom,
  blocks,
  complete,
  layers: ["buildings"],
  bounds: [0.5, 0.5, 0.5 + 1 / 16384, 0.5 + 1 / 16384],
});
const keys = (ts: RenderTile[]) => ts.map((t) => t.key);
test("14 → 15 keeps old coverage through missing directory and partial payloads; swaps only when ready", () => {
  const p = new TilePresentation(),
    resident = new Set([parent.key]);
  expect(keys(p.select(view(14, [parent]), resident))).toEqual([parent.key]);
  expect(keys(p.select(view(15, [], false), resident))).toEqual([parent.key]);
  expect(keys(p.select(view(15, children), resident))).toEqual([parent.key]);
  resident.add(children[0]!.key);
  expect(keys(p.select(view(15, children), resident))).toEqual([parent.key]);
  children.forEach((t) => resident.add(t.key));
  expect(keys(p.select(view(15, children), resident))).toEqual(keys(children));
  // Old meshes can now be released. A cold lower zoom uses the resident children while loading.
  resident.delete(parent.key);
  expect(keys(p.select(view(14, [parent]), resident))).toEqual(keys(children));
  resident.add(parent.key);
  expect(keys(p.select(view(14, [parent]), resident))).toEqual([parent.key]);
});
test("rapid reversals reuse the presented level; failures retain it, but known-empty detail clears it", () => {
  const p = new TilePresentation(),
    resident = new Set([parent.key]);
  p.select(view(14, [parent]), resident);
  p.select(view(15, children), resident);
  expect(keys(p.select(view(16, [], false), resident))).toEqual([parent.key]);
  expect(keys(p.select(view(14, [parent]), resident))).toEqual([parent.key]);
  expect(keys(p.select(view(15, children), resident))).toEqual([parent.key]); // Offline / failed reads never become resident.
  expect(p.select(view(12, [], true), resident)).toEqual([]);
});
test("disabled layers and off-screen fallbacks are removed immediately; first loads and pans stay progressive", () => {
  const p = new TilePresentation(),
    resident = new Set([parent.key]);
  p.select(view(14, [parent]), resident);
  expect(
    p.select({ ...view(15, [], false), layers: ["water"] }, resident),
  ).toEqual([]);
  p.select(view(14, [parent]), resident);
  const elsewhere = tile(15, 16400, 16400);
  resident.add(elsewhere.key);
  expect(
    keys(
      p.select(
        {
          ...view(15, [elsewhere, children[0]!]),
          bounds: [16400 / 32768, 16400 / 32768, 16401 / 32768, 16401 / 32768],
        },
        resident,
      ),
    ),
  ).toEqual([elsewhere.key]);
  expect(p.select({ ...view(15, [], false), layers: [] }, resident)).toEqual(
    [],
  );
});
