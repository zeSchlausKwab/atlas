import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { buildGeocoding } from "../packages/geocoding/src/compile";
import { areaAnchor } from "../packages/geocoding/src/anchor";
import { inside } from "../packages/offline/src/geometry";
test("Sechshauser Straße 60 survives the real PBF importer with its courtyard", async () => {
  const dir = await mkdtemp("/tmp/atlas-building-test-");
  try {
    const proc = Bun.spawn(
      [
        "cargo",
        "run",
        "--quiet",
        "-p",
        "atlas-osm-import",
        "--",
        "tests/fixtures/sechshauser-60.osm.pbf",
        `${dir}/import.json`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited, error).toBe(0);
    const data = await Bun.file(`${dir}/import.json`).json(),
      f = data.geojson.features.find(
        (f: any) => f.properties.id === "relation/2342301",
      );
    expect(f).toBeDefined();
    expect(f.properties.class).toBe(2);
    expect(f.geometry.type).toBe("MultiPolygon");
    expect(f.geometry.coordinates[0].length).toBe(2);
    expect(data.skippedRelations).toBe(0);
    const [outer, hole] = f.geometry.coordinates[0],
      anchor = areaAnchor(f.geometry.coordinates)!;
    expect(inside(anchor, outer)).toBe(true);
    expect(inside(anchor, hole)).toBe(false);
    // The same relation can carry a POI; its identity and interior anchor survive search compilation.
    f.properties.tags.name = "Courtyard museum";
    f.properties.tags.tourism = "museum";
    const search = buildGeocoding([], data.geojson);
    expect(search.locations.records[0]!.id).toBe("relation/2342301");
    expect(inside(search.locations.records[0]!.coordinates, hole)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("Danube water survives a nested sand-island relation", async () => {
  const dir = await mkdtemp("/tmp/atlas-water-test-");
  try {
    const proc = Bun.spawn(
      [
        "cargo",
        "run",
        "--quiet",
        "-p",
        "atlas-osm-import",
        "--",
        "tests/fixtures/danube-2742635.osm.pbf",
        `${dir}/import.json`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited, error).toBe(0);
    const data = await Bun.file(`${dir}/import.json`).json();
    const river = data.geojson.features.find(
      (f: any) => f.properties.id === "relation/2742635",
    );
    expect(river).toBeDefined();
    expect(river.geometry.type).toBe("MultiPolygon");
    const polygon = river.geometry.coordinates[0];
    expect(polygon.length).toBe(2);
    expect(inside([16.34, 48.31], polygon[0])).toBe(true);
    expect(inside([16.34, 48.31], polygon[1])).toBe(false);
    const island = areaAnchor([[polygon[1]]])!;
    expect(inside(island, polygon[0])).toBe(true);
    expect(inside(island, polygon[1])).toBe(true);
    expect(data.skippedRelations).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
