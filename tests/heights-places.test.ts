import { expect, test } from "bun:test";
import { buildingHeight, meters } from "../packages/format/src/heights";
import { tileRecords, splitTile } from "../packages/format/src/tiles";
import { encodeTile } from "../packages/cli/src/tile-codec";
import { displayMinZoom } from "../packages/cli/src/display";
import { encodePackage } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  encodePlaces,
  decodePlaces,
  PLACE_LABEL_KEY,
} from "../packages/labels/src/places";
import { extract, type Selection } from "../packages/offline/src/index";
import type { Manifest } from "../packages/format/src/index";
import { FLAT_SCENE, parseScene } from "../packages/renderer/src/style";

test("height tags take priority, floor estimates are explicit and unknowns stay unknown", () => {
  expect(
    buildingHeight({ height: "42 m", "building:levels": "8", min_height: "6" }),
  ).toEqual({ height: 42, minHeight: 6, source: 5 });
  expect(
    buildingHeight({
      "building:levels": "4",
      "roof:height": "2.5",
      "building:min_level": "1",
    }),
  ).toEqual({ height: 14.5, minHeight: 3, source: 10 });
  expect(
    buildingHeight({ "building:levels": "4", "roof:levels": "2" }).height,
  ).toBe(18);
  expect(buildingHeight({})).toEqual({ height: -1, minHeight: 0, source: 0 });
  expect(buildingHeight({ height: "20", min_height: "30" })).toEqual({
    height: 20,
    minHeight: 0,
    source: 1,
  });
  expect(meters("100 ft")).toBeCloseTo(30.48);
  expect(meters(`6'2"`)).toBeCloseTo(1.8796);
  for (const value of ["NaN", "Infinity", "-5", "20;30", "3000", "5 storeys"])
    expect(meters(value)).toBeUndefined();
  expect(displayMinZoom({ class: 2 })).toBe(13);
  expect(
    parseScene({ pitch: 40, bearing: 10, buildingHeight: 18, shading: 0.5 }),
  ).toEqual({
    ...FLAT_SCENE,
    pitch: 40,
    bearing: 10,
    extrude: true,
    fallbackHeight: 18,
    shading: 0.5,
  });
  expect(() => parseScene({ ...FLAT_SCENE, heightScale: Infinity })).toThrow();
});
const geometry = [
  [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    [0, 0],
  ],
];
const tiles = () =>
  encodeTile([
    {
      type: 3,
      geometry,
      tags: { class: 2, tags: { height: "24", min_height: "6" } },
    },
    { type: 3, geometry, tags: { class: 1 } },
    { type: 3, geometry, tags: { class: 2, tags: { "building:levels": "3" } } },
  ] as any);
test("TIL2 heights survive selective splitting and invalid attributes fail before rendering", () => {
  const bytes = tiles(),
    parts = splitTile(bytes);
  expect(new TextDecoder().decode(parts[0]!.bytes.slice(0, 4))).toBe("TIL2");
  const records = [
    ...tileRecords(parts.find((p) => p.layer === "buildings")!.bytes),
  ];
  expect(records.map((r) => r.height)).toEqual([
    { height: 24, minHeight: 6, source: 5 },
    { height: 9, minHeight: 0, source: 2 },
  ]);
  for (const value of [NaN, Infinity, -2, 0, 2001]) {
    const invalid = bytes.slice();
    new DataView(invalid.buffer).setFloat32(12, value, true);
    expect(() => [...tileRecords(invalid)]).toThrow("height");
  }
  expect(() => [...tileRecords(bytes.slice(0, 17))]).toThrow("height");
});
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Height and places",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [0, 0, 20, 20],
  minZoom: 0,
  maxZoom: 0,
  features: 3,
  peaks: 0,
  places: [],
  tileLayers: ["water", "buildings"],
  labelZoom: 12,
  buildingHeights: { tagged: 1, estimated: 1, missing: 0, maxMeters: 24 },
  capabilities: ["vector-rendering", "building-heights", "map-labels"],
  limitations: [],
};
const selection: Selection = {
  polygon: [
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
  ],
  name: "Child",
  minZoom: 0,
  maxZoom: 0,
  layers: ["buildings"],
  placeNames: false,
  streetNames: false,
  pois: false,
  routing: false,
  search: false,
};
test("settlement labels are opt-in reads; offline selections retain heights and only requested names", async () => {
  const reads: string[] = [];
  const pkg = await encodePackage(manifest, [
    ...splitTile(tiles()).map((p) => ({
      key: `tile/${p.layer}/0/0/0`,
      z: 0,
      x: 0,
      y: 0,
      features: p.features,
      bytes: p.bytes,
    })),
    {
      key: PLACE_LABEL_KEY,
      bytes: encodePlaces([
        { name: "Inside", coordinates: [2, 2] },
        { name: "Outside", coordinates: [10, 10] },
      ]),
    },
  ]);
  const parent = await new AtlasReader(new FileSource(new Blob([pkg])), (e) => {
    if (!e.cached) reads.push(e.key);
  }).open();
  expect(reads).toEqual(["header", "index"]);
  const without = await new AtlasReader(
    new FileSource(await extract(parent, selection)),
  ).open();
  expect(reads).not.toContain(PLACE_LABEL_KEY);
  expect(without.index.manifest.buildingHeights).toEqual(
    manifest.buildingHeights,
  );
  const childRecords = [
    ...tileRecords(await without.block("tile/buildings/0/0/0")),
  ];
  expect(childRecords[0]!.height?.height).toBe(24);
  const withNames = await new AtlasReader(
    new FileSource(await extract(parent, { ...selection, placeNames: true })),
  ).open();
  expect(decodePlaces(await withNames.block(PLACE_LABEL_KEY))).toEqual([
    { name: "Inside", coordinates: [2, 2] },
  ]);
  expect(parent.bytesByPurpose.placeNames).toBeGreaterThan(0);
  expect(parent.bytesByPurpose.search).toBe(0);
});
