import { expect, test } from "bun:test";
import { buildLabels, partitionLabels } from "../packages/labels/src/compile";
import { decodeLabels } from "../packages/labels/src/index";
import { roadPlacement, overlaps } from "../packages/renderer/src/labels";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import { extract } from "../packages/offline/src/index";
import { unproject } from "../packages/format/src/index";
import type { Location, Position } from "../packages/geocoding/src/model";
import { inside } from "../packages/offline/src/geometry";
const point: Position = [16.32986, 48.18735];
const poi: Location = {
  id: "relation/2342301",
  name: "Museum",
  kind: "poi",
  category: "museum",
  aliases: [],
  coordinates: point,
};
test("roads crossing label cells retain continuous fragments on both sides", () => {
  const a = unproject(2233.9 / 4096, 1421.4 / 4096),
    b = unproject(2234.1 / 4096, 1421.4 / 4096);
  const labels = buildLabels(
    { schema: "locations-v1", records: [] },
    {
      schema: "streets-v1",
      streets: [
        {
          id: "way/1",
          name: "Crossing road",
          aliases: [],
          category: "residential",
          coordinates: [a, b],
        },
      ],
    },
  );
  expect(labels.size).toBe(2);
  const left = labels.get("labels/12/2233/1421")!.roads[0]!,
    right = labels.get("labels/12/2234/1421")!.roads[0]!;
  expect(left.coordinates.at(-1)).toEqual(right.coordinates[0]);
  expect(left.coordinates[0]).toEqual(a);
  expect(right.coordinates.at(-1)).toEqual(b);
});
test("label text fits along the visible road and remains upright", () => {
  const p = roadPlacement(
    [
      [-100, 100],
      [900, 100],
    ],
    120,
    600,
    400,
  )!;
  expect(p).not.toBeNull();
  expect(p.x).toBeCloseTo(300);
  expect(p.angle).toBe(0);
  const reverse = roadPlacement(
    [
      [550, 300],
      [40, 60],
    ],
    90,
    600,
    400,
  )!;
  expect(Math.abs(reverse.angle)).toBeLessThan(Math.PI / 2);
  expect(
    roadPlacement(
      [
        [0, 0],
        [10, 10],
      ],
      100,
      600,
      400,
    ),
  ).toBeNull();
  expect(overlaps([0, 0, 20, 20], [10, 10, 30, 30])).toBe(true);
});
test("label blocks validate relation identities and reject invalid geometry", () => {
  const b = { schema: "labels-v1", pois: [poi], roads: [] };
  expect(
    decodeLabels(new TextEncoder().encode(JSON.stringify(b))).pois[0]!.id,
  ).toBe(poi.id);
  expect(() =>
    decodeLabels(
      new TextEncoder().encode(
        JSON.stringify({
          ...b,
          roads: [
            {
              id: "way/1",
              name: "bad",
              category: "street",
              coordinates: [
                [999, 0],
                [0, 0],
              ],
            },
          ],
        }),
      ),
    ),
  ).toThrow("Invalid");
});
test("offline map exports retain clipped labels independently of the search option", async () => {
  const polygon: Position[] = [
    [16.32, 48.18],
    [16.34, 48.18],
    [16.34, 48.19],
    [16.32, 48.19],
  ];
  const labels = buildLabels(
    {
      schema: "locations-v1",
      records: [poi, { ...poi, id: "node/2", coordinates: [16.35, 48.18] }],
    },
    {
      schema: "streets-v1",
      streets: [
        {
          id: "way/1",
          name: "Long road",
          aliases: [],
          category: "residential",
          coordinates: [
            [16.3, 48.185],
            [16.36, 48.185],
          ],
        },
      ],
    },
  );
  const parts = partitionLabels(labels);
  expect([...parts.keys()].every((k) => /\/(roads|pois)\/\d+$/.test(k))).toBe(
    true,
  );
  const bytes = await encodePackage(
    {
      format: "atlas",
      version: 1,
      name: "labels",
      source: {
        url: "fixture",
        sha256: "0".repeat(64),
        attribution: "fixture",
      },
      bounds: [16.3, 48.17, 16.36, 48.2],
      minZoom: 0,
      maxZoom: 0,
      features: 1,
      peaks: 0,
      places: [],
      capabilities: ["vector-rendering", "map-labels"],
      labelZoom: 12,
      limitations: [],
    },
    [
      {
        key: "tile/0/0/0",
        z: 0,
        x: 0,
        y: 0,
        features: 1,
        bytes: new Uint8Array([1]),
      },
      ...[...parts].map(([key, b]) => ({
        key,
        bytes: new TextEncoder().encode(JSON.stringify(b)),
      })),
    ],
    { paged: true },
  );
  const r = await new AtlasReader(new FileSource(new Blob([bytes]))).open();
  const blob = await extract(r, {
    name: "Offline labels",
    polygon,
    minZoom: 0,
    maxZoom: 0,
    routing: false,
    search: false,
  });
  const child = await new AtlasReader(new FileSource(blob)).open();
  expect(child.index.manifest.capabilities).toContain("map-labels");
  expect(child.index.manifest.capabilities).not.toContain("location-search");
  const blocks = await Promise.all(
    child.index.blocks
      .filter((b) => b.key.startsWith("labels/"))
      .map(async (b) => decodeLabels(await child.block(b.key))),
  );
  expect(blocks.flatMap((b) => b.pois).map((p) => p.id)).toEqual([poi.id]);
  expect(
    blocks
      .flatMap((b) => b.roads)
      .every((r) => r.coordinates.every((p) => inside(p, polygon))),
  ).toBe(true);
});
