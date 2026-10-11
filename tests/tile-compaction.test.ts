import { expect, test } from "bun:test";
import type geojsonvt from "geojson-vt";
import { mkdtemp, rm } from "node:fs/promises";
import { BlockSpool } from "../packages/cli/src/block-spool";
import { encodeTile } from "../packages/cli/src/tile-codec";
import { tileRecords } from "../packages/format/src/tiles";
import type { InputBlock } from "../packages/format/src/writer";

const ring = (x: number, y: number, side: number) => [
  [x, y],
  [x + side, y],
  [x + side, y + side],
  [x, y + side],
  [x, y],
];
// The upstream type declares only point geometry; runtime polygon geometry is nested.
const polygon = (rings: number[][][], cls = 0): geojsonvt.Feature => ({
  type: 3 as const,
  geometry: rings as unknown as geojsonvt.Feature["geometry"],
  tags: { class: cls },
});
async function pack(fill: (spool: BlockSpool) => void) {
  const dir = await mkdtemp("/tmp/atlas-compact-test-");
  const spool = new BlockSpool(dir + "/spool.sqlite", "fixture");
  const blocks: InputBlock[] = [];
  try {
    spool.begin();
    fill(spool);
    spool.checkpoint(1);
    await spool.write(
      {
        add: async (b) => {
          blocks.push(b);
        },
      },
      new AbortController().signal,
      () => {},
    );
    return blocks;
  } finally {
    spool.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test("coarse land packing recovers an over-limit saved spool by dropping subpixel polygon parts", async () => {
  // A saved batch is valid alone; their aggregate crosses BOTH old tile limits.
  const tiny = encodeTile(
    Array.from({ length: 5000 }, () => polygon([ring(100, 100, 1)])),
  );
  const visible = encodeTile([polygon([ring(1000, 1000, 1000)])]);
  const blocks = await pack((spool) => {
    for (let i = 0; i < 121; i++) spool.add("tile/land/4/7/5", tiny);
    spool.add("tile/land/4/7/5", visible);
  });
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.features).toBe(1);
  expect(blocks[0]!.bytes).toEqual(visible);
}, 10000);
test("coarse multipolygons keep visible exteriors and their holes byte-exact; omit tiny exteriors with their holes", async () => {
  const outer = ring(1000, 1000, 1000),
    hole = ring(1100, 1100, 1).reverse();
  const tiny = ring(4000, 4000, 100),
    tinyHole = ring(4010, 4010, 10).reverse();
  const next = ring(8000, 8000, 2000),
    nextHole = ring(8100, 8100, 500).reverse();
  const blocks = await pack((spool) =>
    spool.add(
      "tile/water/5/15/10",
      encodeTile([polygon([outer, hole, tiny, tinyHole, next, nextHole], 1)]),
    ),
  );
  expect(blocks[0]!.bytes).toEqual(
    encodeTile([polygon([outer, hole, next, nextHole], 1)]),
  );
});
test("subpixel filtering leaves detail zooms, roads, point features and building heights unchanged", async () => {
  const detail = encodeTile([polygon([ring(100, 100, 1)])]);
  const building = encodeTile([
    {
      ...polygon([ring(100, 100, 1)], 2),
      tags: { class: 2, tags: { height: "12" } },
    },
  ]);
  const road = encodeTile([
    {
      ...polygon(
        [
          [
            [1, 1],
            [2, 2],
          ],
        ],
        4,
      ),
      type: 2,
    },
  ]);
  const point = encodeTile([
    { type: 1, geometry: [[1, 1]], tags: { class: 7 } },
  ]);
  const blocks = await pack((spool) => {
    spool.add("tile/land/13/1/1", detail);
    spool.add("tile/buildings/13/1/1", building);
    spool.add("tile/roads/4/7/5", road);
    spool.add("tile/peaks/4/7/5", point);
  });
  expect(blocks.find((b) => b.key.includes("land"))!.bytes).toEqual(detail);
  expect(blocks.find((b) => b.key.includes("buildings"))!.bytes).toEqual(
    building,
  );
  expect(
    [...tileRecords(blocks.find((b) => b.key.includes("buildings"))!.bytes)][0]!
      .height!.height,
  ).toBe(12);
  expect(blocks.find((b) => b.key.includes("roads"))!.bytes).toEqual(road);
  expect(blocks.find((b) => b.key.includes("peaks"))!.bytes).toEqual(point);
});
test("tiles containing only collapsed or subpixel areas are absent, not empty blocks", async () => {
  const blocks = await pack((spool) =>
    spool.add(
      "tile/land/0/0/0",
      encodeTile([polygon([ring(1, 1, 1)]), polygon([ring(2, 2, 0)])]),
    ),
  );
  expect(blocks).toEqual([]);
});

test("packing mixed old and prefiltered checkpoints is idempotent", async () => {
  const { compactDisplayTile } = await import(
    "../packages/cli/src/display-tile"
  );
  const mixed = encodeTile([
    polygon([ring(100, 100, 1)]),
    polygon([ring(1000, 1000, 1000), ring(1100, 1100, 2).reverse()]),
  ]);
  const filtered = compactDisplayTile(mixed, 4);
  expect(compactDisplayTile(filtered, 4)).toEqual(filtered);
  const resumed = await pack((spool) => {
    spool.add("tile/land/4/7/5", mixed);
    spool.add("tile/land/4/7/5", filtered);
  });
  const fresh = await pack((spool) => {
    spool.add("tile/land/4/7/5", filtered);
    spool.add("tile/land/4/7/5", filtered);
  });
  expect(resumed).toEqual(fresh);
});
test("detail overflow still fails instead of bypassing the decoder safety budget", async () => {
  const tiny = encodeTile(
    Array.from({ length: 5000 }, () => polygon([ring(100, 100, 1)])),
  );
  await expect(
    pack((spool) => {
      for (let i = 0; i < 121; i++) spool.add("tile/land/16/30000/20000", tiny);
    }),
  ).rejects.toThrow("3,000,000-point limit after display filtering");
});
