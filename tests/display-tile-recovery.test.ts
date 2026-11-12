import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type geojsonvt from "geojson-vt";
import {
  generalizePackedDisplay,
  validGeneralizedPolygons,
} from "../packages/cli/src/display-tile-recovery";
import { BlockSpool } from "../packages/cli/src/block-spool";
import { encodeTile } from "../packages/cli/src/tile-codec";
import { tileRecords } from "../packages/format/src/tiles";
import { renderTileBatch } from "../packages/cli/src/tile-batch";
import type { PackageSelection } from "../packages/provisioning/src/selection";

function denseRing(x: number, y: number, size: number) {
  const corners = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  return corners
    .slice(0, 4)
    .flatMap((a, i) =>
      Array.from({ length: 1000 }, (_, j) => [
        Math.round(a[0]! + ((corners[i + 1]![0]! - a[0]!) * j) / 1000),
        Math.round(a[1]! + ((corners[i + 1]![1]! - a[1]!) * j) / 1000),
      ]),
    )
    .concat([corners[0]!]);
}
const polygon = (rings: number[][][]) =>
  ({
    type: 3,
    geometry: rings,
    tags: { class: 1 },
  }) as unknown as geojsonvt.Feature;
const outer = denseRing(1000, 1000, 10000),
  hole = [
    [2000, 2000],
    [2000, 3000],
    [3000, 3000],
    [3000, 2000],
    [2000, 2000],
  ],
  island = [
    [20000, 20000],
    [21000, 20000],
    [21000, 21000],
    [20000, 21000],
    [20000, 20000],
  ];

test("packed tile recovery honors cancellation before any IO", async () => {
  const signal = AbortSignal.abort(new Error("stop packing"));
  await expect(
    generalizePackedDisplay([], "tile/water/6/15/21", "/unused", signal),
  ).rejects.toThrow("stop packing");
});

test("coarse last zoom receives the same simplification as an intermediate zoom", () => {
  const ring = denseRing(0, 0, 10000).map((p) => [
    p[0]! / 10000,
    p[1]! / 10000,
  ]);
  const feature = {
    type: "Feature" as const,
    properties: { class: 1, tags: { natural: "water" } },
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
  const selection: PackageSelection = {
    snapshot: "0".repeat(64),
    name: "coarse display",
    polygon: [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ],
    minZoom: 6,
    maxZoom: 6,
    layers: ["water"],
    placeNames: false,
    streetNames: false,
    pois: false,
    profiles: [],
    search: false,
    reverse: false,
    peaks: false,
    featureKinds: [],
    paddingCells: 0,
    maxBytes: 50 * 1024 ** 2,
  };
  const run = (maxZoom: number) => {
    const out = new Map<string, Uint8Array>();
    renderTileBatch(
      [feature],
      { ...selection, maxZoom },
      new AbortController().signal,
      (key, b) => {
        if (key.startsWith("tile/water/6/")) out.set(key, b);
      },
    );
    return out;
  };
  const coarse = run(6),
    next = run(7);
  expect(coarse.size).toBeGreaterThan(0);
  expect(coarse).toEqual(next);
  expect(
    [...coarse.values()]
      .flatMap((b) => [...tileRecords(b)])
      .reduce((n, r) => n + r.pointCount, 0),
  ).toBeLessThan(100);
});

(Bun.which("ogr2ogr") ? test : test.skip)(
  "saved over-budget water tile packs under unchanged decoder limits with every exterior and hole",
  async () => {
    const dir = await mkdtemp("/tmp/atlas-tile-recovery-");
    const spool = new BlockSpool(dir + "/fragments.sqlite", "test");
    try {
      const fragment = encodeTile(
        Array.from({ length: 300 }, () => polygon([outer, hole, island])),
      );
      const before = new Uint8Array(fragment);
      spool.begin();
      for (let i = 0; i < 3; i++) spool.add("tile/water/6/15/21", fragment);
      spool.checkpoint(1);
      const messages: string[] = [];
      const blocks: Uint8Array[] = [];
      await spool.write(
        {
          add: async (b) => {
            blocks.push(b.bytes);
          },
        },
        new AbortController().signal,
        () => {},
        (m) => messages.push(m),
      );
      expect(messages.some((m) => m.includes("Generalizing crowded"))).toBe(
        true,
      );
      expect(blocks).toHaveLength(1);
      const records = [...tileRecords(blocks[0]!)];
      expect(records).toHaveLength(900);
      expect(records.every((r) => r.parts === 3 && r.class === 1)).toBe(true);
      expect(records.reduce((n, r) => n + r.pointCount, 0)).toBe(900 * 15);
      const v = new DataView(blocks[0]!.buffer);
      let at = records[0]!.geometryOffset;
      const rings: number[][][] = [];
      for (let p = 0; p < 3; p++) {
        const n = v.getUint32(at, true);
        at += 4;
        const r: number[][] = [];
        for (let i = 0; i < n; i++, at += 4)
          r.push([v.getUint16(at, true), v.getUint16(at + 2, true)]);
        rings.push(r);
      }
      expect(rings[0]).toContainEqual([1000, 1000]);
      expect(rings[0]).toContainEqual([11000, 11000]);
      expect(rings[1]).toEqual(hole);
      expect(rings[2]).toEqual(island);
      expect(fragment).toEqual(before);
      expect(await readdir(dir)).toEqual(["fragments.sqlite"]);
    } finally {
      spool.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

(Bun.which("ogr2ogr") ? test : test.skip)(
  "tile recovery preserves unrelated records and removes scratch on cancellation",
  async () => {
    const dir = await mkdtemp("/tmp/atlas-tile-recovery-");
    try {
      const water = encodeTile([polygon([outer, hole, island])]);
      const road = encodeTile([
        {
          type: 2,
          geometry: [
            [
              [1, 2],
              [3, 4],
            ],
          ],
          tags: { class: 4 },
        } as unknown as geojsonvt.Feature,
      ]);
      const parts = await generalizePackedDisplay(
        [water, road],
        "tile/water/6/1/1",
        dir,
        new AbortController().signal,
      );
      expect(parts[1]).toEqual(road);
      const c = new AbortController();
      await expect(
        generalizePackedDisplay(
          [water],
          "tile/water/6/1/1",
          dir,
          c.signal,
          () => c.abort(new Error("cancel GDAL")),
        ),
      ).rejects.toThrow("cancel GDAL");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

test("invalid or incomplete generalizations retain the original polygon record", () => {
  expect(validGeneralizedPolygons([[outer, hole], [island]], [2, 1])).toBe(
    true,
  );
  expect(validGeneralizedPolygons([[outer], [island]], [2, 1])).toBe(false);
  expect(validGeneralizedPolygons([[outer, hole]], [2, 1])).toBe(false);
  expect(
    validGeneralizedPolygons(
      [
        [
          [
            [1, 1],
            [2, 2],
            [3, 3],
            [1, 1],
          ],
        ],
      ],
      [1],
    ),
  ).toBe(false);
  expect(validGeneralizedPolygons([[outer.slice(0, -1)]], [1])).toBe(false);
  expect(
    validGeneralizedPolygons(
      [
        [
          [
            [-1, 0],
            [1, 0],
            [1, 1],
            [-1, 0],
          ],
        ],
      ],
      [1],
    ),
  ).toBe(false);
});
