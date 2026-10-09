import { expect, test } from "bun:test";
import {
  clipArrays,
  contains,
  coverageOf,
  CoveredTiles,
  planComposition,
  type CompositionSource,
} from "../packages/renderer/src/composition-plan";
import { parseCatalog } from "../packages/format/src/catalog";
import { project, type Manifest } from "../packages/format/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
const manifest: Manifest = {
  format: "atlas",
  version: 1,
  name: "Source",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [0, 0, 20, 20],
  minZoom: 0,
  maxZoom: 16,
  features: 1,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering", "map-labels"],
  limitations: [],
  tileLayers: ["water", "buildings", "roads"],
  snapshot: "a".repeat(64),
};
function source(
  id: string,
  bounds = manifest.bounds,
  layers = manifest.tileLayers!,
): CompositionSource {
  return {
    id,
    manifest: { ...manifest, bounds, tileLayers: layers },
    enabled: true,
    layers,
    labels: true,
  };
}
test("priority clips overlap per channel, preserving lower-source holes and unrelated layers", () => {
  const high = source("detail", [5, 5, 15, 15], ["water", "buildings"]),
    low = source("regional");
  const plan = planComposition([high, low], 14),
    water = plan.find(
      (p) => p.source === "regional" && p.channel === "water",
    )!.coverage;
  expect(contains(water, project(10, 10))).toBe(false);
  expect(contains(water, project(2, 2))).toBe(true);
  expect(
    contains(
      plan.find((p) => p.channel === "roads")!.coverage,
      project(10, 10),
    ),
  ).toBe(true);
  expect(
    contains(
      plan.find((p) => p.source === "regional" && p.channel === "labels")!
        .coverage,
      project(10, 10),
    ),
  ).toBe(false);
  expect(clipArrays(water).rings.length).toBe(2);
  // A higher source cannot shadow a channel it has not subscribed to.
  high.layers = ["buildings"];
  high.labels = false;
  const again = planComposition([high, low], 14);
  expect(
    contains(
      again.find((p) => p.channel === "water")!.coverage,
      project(10, 10),
    ),
  ).toBe(true);
  expect(
    contains(
      again.find((p) => p.channel === "labels")!.coverage,
      project(10, 10),
    ),
  ).toBe(true);
});
test("disjoint maps compose, disabled and below-minimum maps do not claim coverage; max zoom overzooms", () => {
  const a = source("a"),
    b = source("b", [30, 30, 31, 31]);
  b.manifest.minZoom = 13;
  b.manifest.maxZoom = 14;
  expect(planComposition([a, b], 12).some((p) => p.source === "b")).toBe(false);
  expect(
    planComposition([a, b], 20).filter((p) => p.source === "b"),
  ).toHaveLength(4);
  a.enabled = false;
  expect(planComposition([a, b], 13).some((p) => p.source === "a")).toBe(false);
});
test("polygonal coverage is respected, rather than claiming its full bounding box", () => {
  const s = source("triangle");
  s.manifest.selection = {
    polygon: [
      [0, 0],
      [20, 0],
      [0, 20],
    ],
    parentSnapshot: manifest.snapshot,
    boundaryPolicy: "test",
  };
  const polygon = coverageOf(s.manifest);
  expect(contains(polygon, project(2, 2))).toBe(true);
  expect(contains(polygon, project(18, 18))).toBe(false);
});
test("fully shadowed tiles are not requested, and same tile keys keep independent snapshot bytes", async () => {
  const make = async (value: number) => {
    const bytes = new Uint8Array([84, 73, 76, 49, 0, 0, 0, 0, value]);
    const encoded = await encodePackage(
      {
        ...manifest,
        bounds: [-180, -85, 180, 85],
        minZoom: 1,
        maxZoom: 1,
        tileLayers: ["water"],
        capabilities: ["vector-rendering"],
      },
      [{ key: "tile/water/1/1/0", z: 1, x: 1, y: 0, bytes, features: 0 }],
    );
    const reader = await new AtlasReader(
      new FileSource(new Blob([encoded])),
      undefined,
      { purposes: ["map"] },
    ).open();
    return { reader, view: new CoveredTiles(reader) };
  };
  const a = await make(1),
    b = await make(2);
  a.view.parts.set(
    "water",
    coverageOf({ ...manifest, bounds: [-170, -80, -20, -10] }),
  );
  expect(await a.view.tiles(1, 0, 1, 0, 1, ["water"])).toHaveLength(0);
  expect(a.reader.bytesByPurpose.map).toBe(0);
  b.view.parts.set("water", coverageOf(manifest));
  expect(await b.view.tiles(1, 0, 1, 0, 1, ["water"])).toHaveLength(1);
  expect(a.reader.index.manifest.snapshot).not.toBe(
    b.reader.index.manifest.snapshot,
  );
  expect((await a.view.block("tile/water/1/1/0")).at(-1)).toBe(1);
  expect((await b.view.block("tile/water/1/1/0")).at(-1)).toBe(2);
  expect(a.reader.bytesByPurpose.routing).toBe(0);
  a.reader.dispose();
  b.reader.dispose();
});
test("catalog URLs resolve against their host; unsafe URLs and malformed offers are rejected", () => {
  const offer = {
    id: "slice",
    url: "/maps/slice.atlas",
    api: "/maps/slice/api",
    bytes: 1000,
    manifest,
  };
  const result = parseCatalog(
    { maps: [offer] },
    "https://maps.example/catalog",
  );
  expect(result[0]!.url).toBe("https://maps.example/maps/slice.atlas");
  expect(result[0]!.api).toBe("https://maps.example/maps/slice/api");
  expect(() =>
    parseCatalog(
      { maps: [{ ...offer, url: "javascript:alert(1)" }] },
      "https://maps.example/catalog",
    ),
  ).toThrow();
  expect(() =>
    parseCatalog(
      { maps: [{ ...offer, url: "https://user:secret@example.com/map" }] },
      "https://maps.example/catalog",
    ),
  ).toThrow();
  expect(() =>
    parseCatalog(
      {
        maps: [{ ...offer, manifest: { ...manifest, bounds: [0, 0, NaN, 1] } }],
      },
      "https://maps.example/catalog",
    ),
  ).toThrow();
  expect(() =>
    parseCatalog({ maps: [offer, offer] }, "https://maps.example/catalog"),
  ).toThrow();
});
