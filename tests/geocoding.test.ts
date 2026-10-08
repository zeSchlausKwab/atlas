import { describe, test, expect } from "bun:test";
import {
  AtlasGeocoder,
  normalize,
  parseCoordinates,
  type Location,
} from "../packages/geocoding/src/index";
import { buildGeocoding } from "../packages/geocoding/src/compile";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import type { Manifest } from "../packages/format/src/index";
import type { FeatureCollection, Feature } from "geojson";
const nodes: Location[] = [
  {
    id: "node/1",
    name: "Vaduz",
    aliases: ["Vadoz"],
    kind: "place",
    category: "town",
    coordinates: [9.515, 47.139],
  },
  {
    id: "node/2",
    name: "Museum Vaduz",
    aliases: [],
    kind: "poi",
    category: "museum",
    coordinates: [9.519, 47.139],
  },
];
const way = (
  id: number,
  name: string | undefined,
  highway: string,
  y: number,
): Feature => ({
  type: "Feature",
  properties: { id: `way/${id}`, tags: { name, highway } },
  geometry: {
    type: "LineString",
    coordinates: [
      [9.51, y],
      [9.52, y],
    ],
  },
});
const source: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    way(10, "Äußere Straße", "residential", 47.14),
    way(11, undefined, "service", 47.141),
    way(12, "Short path", "footway", 47.14099),
    way(13, "Äußere Straße", "residential", 47.142),
  ],
};
const metadata: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Search fixture",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [9.5, 47.13, 9.53, 47.15],
  minZoom: 9,
  maxZoom: 9,
  features: 4,
  peaks: 0,
  places: [],
  capabilities: ["location-search", "reverse-street"],
  limitations: [],
};
async function fixture(corrupt = false) {
  const compiled = buildGeocoding(nodes, source);
  const pkg = await encodePackage(metadata, [
    {
      key: "search/locations",
      features: compiled.locations.records.length,
      bytes: new TextEncoder().encode(JSON.stringify(compiled.locations)),
    },
    {
      key: "search/streets",
      features: compiled.streets.streets.length,
      bytes: new TextEncoder().encode(JSON.stringify(compiled.streets)),
    },
  ]);
  if (corrupt) pkg[pkg.length - 10] ^= 1;
  const reader = await new AtlasReader(new FileSource(new Blob([pkg]))).open();
  return { reader, geocoder: new AtlasGeocoder(reader) };
}
describe("Local geocoding", () => {
  test("compiler groups named street fragments by nearby settlement and excludes paths", () => {
    const first = buildGeocoding(nodes, source),
      second = buildGeocoding(nodes, source);
    expect(first).toEqual(second);
    expect(
      first.locations.records.filter((r) => r.kind === "street"),
    ).toHaveLength(1);
    expect(first.streets.streets).toHaveLength(3);
    expect(first.streets.streets.some((s) => s.name === null)).toBe(true);
    expect(nodes[1]!.context).toBeUndefined();
  });
  test("search ranks exact names, aliases, accents and context without loading street geometry", async () => {
    const { reader, geocoder } = await fixture();
    const result = await geocoder.search("vaduz");
    expect(result.matches[0]?.name).toBe("Vaduz");
    expect(result.snapshot).toBe(reader.index.manifest.snapshot);
    expect((await geocoder.search("vadoz")).matches[0]?.name).toBe("Vaduz");
    expect(
      (await geocoder.search("aussere strasse vaduz")).matches[0]?.name,
    ).toBe("Äußere Straße");
    expect((await geocoder.search("absent name")).total).toBe(0);
    expect(reader.requests).toBe(3);
    expect(reader.cache.has("search/streets")).toBe(false);
  });
  test("reverse projects along a segment instead of snapping to vertices", async () => {
    const { reader, geocoder } = await fixture();
    const result = await geocoder.reverse([9.515, 47.14005]);
    expect(result.match?.name).toBe("Äußere Straße");
    expect(result.match?.nearest[0]).toBeCloseTo(9.515, 6);
    expect(result.match?.nearest[1]).toBeCloseTo(47.14, 6);
    expect(result.match?.distanceMeters).toBeGreaterThan(5);
    expect(result.match?.distanceMeters).toBeLessThan(6);
    expect(reader.cache.has("search/locations")).toBe(false);
  });
  test("nearest unnamed street is not silently replaced by a farther named street", async () => {
    const { geocoder } = await fixture();
    const result = await geocoder.reverse([9.515, 47.14096]);
    expect(result.match?.id).toBe("way/11");
    expect(result.match?.name).toBeNull();
    expect((await geocoder.reverse([8, 48])).match).toBeNull();
  });
  test("search and reverse have independent offline availability and retry", async () => {
    const { reader, geocoder } = await fixture();
    reader.offline = true;
    await expect(geocoder.search("Vaduz")).rejects.toThrow("not cached");
    expect(reader.requests).toBe(2);
    reader.offline = false;
    await geocoder.search("Vaduz");
    reader.offline = true;
    expect((await geocoder.search("Vaduz")).cached).toBe(true);
    await expect(geocoder.reverse([9.515, 47.14])).rejects.toThrow(
      "not cached",
    );
    reader.offline = false;
    await geocoder.reverse([9.515, 47.14]);
    reader.offline = true;
    expect((await geocoder.reverse([9.515, 47.14])).cached).toBe(true);
    expect(reader.requests).toBe(4);
  });
  test("concurrent searches deduplicate reads and corrupted geometry fails integrity", async () => {
    const { reader, geocoder } = await fixture();
    await Promise.all([geocoder.search("vaduz"), geocoder.search("strasse")]);
    expect(reader.requests).toBe(3);
    const bad = await fixture(true);
    await expect(bad.geocoder.reverse([9.515, 47.14])).rejects.toThrow(
      "Integrity",
    );
  });
  test("coordinate order and invalid inputs are explicit", async () => {
    expect(parseCoordinates("47.13929, 9.52280")).toEqual([9.5228, 47.13929]);
    expect(normalize("Äußere Straße")).toBe("aussere strasse");
    for (const bad of ["", "NaN, 9", "47,", "86, 9", "47, 181", "47 9"])
      expect(() => parseCoordinates(bad)).toThrow();
    const { geocoder, reader } = await fixture();
    await expect(geocoder.reverse([NaN, 47])).rejects.toThrow("Invalid");
    await expect(geocoder.search(" ")).rejects.toThrow("2 and 120");
    expect(reader.requests).toBe(2);
  });
});
