import { test, expect } from "bun:test";
import {
  PAPER,
  STYLE_PRESETS,
  parseStyle,
  compileStyle,
  parseScene,
} from "../packages/renderer/src/style";
import { project } from "../packages/format/src/index";
import {
  worldToScreen,
  screenToWorld,
  cameraBounds,
  metersPerPixel,
  fitZoom,
  type Camera,
  type Point,
} from "../packages/renderer/src/camera";
test("portable styles round-trip, isolate mutable state and reject unsupported values", () => {
  for (const preset of Object.values(STYLE_PRESETS))
    expect(parseStyle(JSON.parse(JSON.stringify(preset)))).toEqual(preset);
  const style = parseStyle(PAPER);
  style.colors.water = "#000000";
  expect(PAPER.colors.water).not.toBe(style.colors.water);
  for (const invalid of [
    { ...PAPER, version: 2 },
    { ...PAPER, background: "url(evil)" },
    { ...PAPER, fetch: "anything" },
    { ...PAPER, colors: {} },
    { ...PAPER, widths: { ...PAPER.widths, roads: Infinity } },
    { ...PAPER, labels: { ...PAPER.labels, scale: 10 } },
  ])
    expect(() => parseStyle(invalid)).toThrow();
  const compiled = compileStyle(style);
  expect(compiled.colors.length).toBe(24);
  expect([...compiled.widths].filter((_, i) => i !== 2)).toEqual([
    1, 1, 0.5, 0.5, 1, 1, 1,
  ]);
  expect(compiled.widths[2]).toBeCloseTo(0.6);
  const legacy = JSON.parse(JSON.stringify(PAPER));
  delete legacy.widths.buildingEdges;
  expect(parseStyle(legacy).widths.buildingEdges).toBe(0.6);
  expect(
    parseStyle({ ...PAPER, widths: { ...PAPER.widths, buildingEdges: 0 } })
      .widths.buildingEdges,
  ).toBe(0);
  expect(() =>
    parseStyle({ ...PAPER, widths: { ...PAPER.widths, buildingEdges: 3 } }),
  ).toThrow();
  expect(() =>
    parseScene({ pitch: 90, bearing: 0, buildingHeight: 10, shading: 0.5 }),
  ).toThrow();
});
test("tilted/rotated camera keeps ground picking and viewport coverage consistent", () => {
  for (const pitch of [0, 35, 65])
    for (const bearing of [-180, -45, 0, 90, 180]) {
      const camera: Camera = {
        center: project(16.373, 48.208),
        zoom: 17.5,
        width: 1000,
        height: 700,
        pitch,
        bearing,
      };
      for (const screen of [
        [0, 0],
        [1000, 0],
        [1000, 700],
        [0, 700],
        [750, 230],
      ] as Point[]) {
        const world = screenToWorld(screen, camera),
          result = worldToScreen(world, camera);
        expect(result[0]).toBeCloseTo(screen[0], 5);
        expect(result[1]).toBeCloseTo(screen[1], 5);
        const [w, n, e, s] = cameraBounds(camera);
        expect(world[0]).toBeGreaterThanOrEqual(w);
        expect(world[0]).toBeLessThanOrEqual(e);
        expect(world[1]).toBeGreaterThanOrEqual(n);
        expect(world[1]).toBeLessThanOrEqual(s);
      }
      const p = worldToScreen(camera.center, camera, 20);
      expect(p[0]).toBeCloseTo(500);
      expect(p[1]).toBeCloseTo(
        350 - (20 / metersPerPixel(camera)) * Math.sin((pitch * Math.PI) / 180),
      );
    }
});
test("fit considers the rotated bounds and zoom anchoring retains the pointed-to ground", () => {
  const bounds: [number, number, number, number] = [0.54, 0.34, 0.55, 0.36];
  const camera: Camera = {
    center: [0.545, 0.35],
    zoom: fitZoom(bounds, 1000, 700, 60, 45),
    width: 1000,
    height: 700,
    pitch: 60,
    bearing: 45,
  };
  for (const p of [
    [0.54, 0.34],
    [0.55, 0.34],
    [0.55, 0.36],
    [0.54, 0.36],
  ] as Point[]) {
    const [x, y] = worldToScreen(p, camera);
    expect(x).toBeGreaterThanOrEqual(-0.0001);
    expect(x).toBeLessThanOrEqual(1000.0001);
    expect(y).toBeGreaterThanOrEqual(-0.0001);
    expect(y).toBeLessThanOrEqual(700.0001);
  }
  const pixel: Point = [790, 143],
    before = screenToWorld(pixel, camera),
    zoomed = { ...camera, zoom: camera.zoom + 1 },
    after = screenToWorld(pixel, zoomed);
  zoomed.center = [
    camera.center[0] + before[0] - after[0],
    camera.center[1] + before[1] - after[1],
  ];
  const result = worldToScreen(before, zoomed);
  expect(result[0]).toBeCloseTo(pixel[0], 5);
  expect(result[1]).toBeCloseTo(pixel[1], 5);
});
