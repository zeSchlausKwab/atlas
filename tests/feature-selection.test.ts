import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  buildFeatures,
  featureClasses,
} from "../packages/features/src/compile";
import { LEGACY_FEATURE_KINDS } from "../packages/features/src/index";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { partitionedIdentity } from "../packages/cli/src/partitioned-state";
import { fileHash } from "../packages/cli/src/source";
import { compilerProgress } from "../packages/provisioning/src/compiler-progress";
import type { PackageSelection } from "../packages/provisioning/src/selection";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  boundaryCatalog,
  findBoundary,
} from "../packages/boundaries/src/index";

const water: Feature<Polygon> = {
  type: "Feature",
  properties: { id: "way/26530066", class: 1, tags: { natural: "water" } },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-30, -30],
        [30, -30],
        [30, 30],
        [-30, 30],
        [-30, -30],
      ],
    ],
  },
};
const building: Feature<Polygon> = {
  type: "Feature",
  properties: { id: "way/1", class: 2, tags: { building: "yes" } },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [16, 48],
        [16.001, 48],
        [16.001, 48.001],
        [16, 48],
      ],
    ],
  },
};
const source: FeatureCollection = {
  type: "FeatureCollection",
  features: [water, building],
};

test("unselected world-sized shapes never enter the regional feature index", () => {
  const selected = buildFeatures(source, ["buildings"]);
  expect(selected.size).toBeGreaterThan(0);
  expect([...selected.values()].flat().every((f) => f.id === "way/1")).toBe(
    true,
  );
  for (const kinds of [[], ["boundaries"], ["objects"]] as const)
    expect(buildFeatures(source, kinds).size).toBe(0);
  // An explicitly requested oversized legacy feature still fails, never silently drops.
  expect(() => buildFeatures(source, ["water"])).toThrow(
    "spans too many cells",
  );
  expect(() => buildFeatures(source)).toThrow("spans too many cells");
});

test("all legacy classes remain selectable, including every road class", () => {
  expect(featureClasses(LEGACY_FEATURE_KINDS)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  const features = Array.from({ length: 7 }, (_, cls) => ({
    ...building,
    properties: { ...building.properties, id: `way/${cls + 1}`, class: cls },
  }));
  const cells = buildFeatures({ type: "FeatureCollection", features }, [
    "roads",
  ]);
  expect(
    [...new Set([...cells.values()].flat().map((f) => f.id))].sort(),
  ).toEqual(["way/4", "way/5", "way/6"]);
});

test("world boundary preparation reuses source checkpoints and reads only selected geometry", async () => {
  const dir = await mkdtemp("/tmp/atlas-feature-selection-");
  const work = dir + "/work",
    input = dir + "/source.pbf",
    output = dir + "/world.atlas";
  const boundary: Feature<Polygon> = {
    ...building,
    properties: {
      id: "relation/100",
      class: 9,
      name: "Test municipality",
      tags: { boundary: "administrative", admin_level: "8" },
    },
  };
  const selection: PackageSelection = {
    snapshot: "0".repeat(64),
    name: "World boundaries",
    polygon: [
      [-180, -85],
      [180, -85],
      [180, 85],
      [-180, 85],
    ],
    minZoom: 0,
    maxZoom: 6,
    layers: [],
    profiles: [],
    paddingCells: 0,
    placeNames: true,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    featureKinds: ["boundaries"],
    boundaryMaxAdminLevel: 10,
    maxBytes: 50 * 1024 ** 2,
  };
  try {
    await mkdir(work);
    // A receipted native source stage lets this exercise resume without native tools.
    await Bun.write(input, "synthetic pinned source");
    const path = work + "/source-v4.sqlite";
    const db = new Database(path);
    try {
      db.run(
        "CREATE TABLE features(id TEXT,class INTEGER,data BLOB,cell INTEGER); CREATE TABLE metadata(key TEXT,json TEXT); CREATE TABLE locations(id TEXT,kind TEXT,category TEXT,json TEXT)",
      );
      db.query("INSERT INTO metadata VALUES('stats',?)").run(
        JSON.stringify({
          assembledRelations: 1,
          skippedRelations: 0,
          skippedWays: 0,
        }),
      );
      db.query("INSERT INTO locations VALUES('node/1','place','city',?)").run(
        JSON.stringify({
          name: "Test city",
          category: "city",
          coordinates: [16, 48],
        }),
      );
      for (const f of [water, building, boundary])
        db.query("INSERT INTO features VALUES(?,?,?,0)").run(
          f.properties!.id,
          f.properties!.class,
          Bun.gzipSync(JSON.stringify(f)),
        );
      // This unselected payload must not even be decompressed during semantics.
      db.query("INSERT INTO features VALUES('way/999',1,?,0)").run(
        new Uint8Array([0, 1, 2]),
      );
    } finally {
      db.close();
    }
    await Bun.write(
      work + "/partitioned.json",
      JSON.stringify({
        identity: partitionedIdentity(await fileHash(input), selection),
        completed: {
          "source-v4.sqlite": {
            size: Bun.file(path).size,
            sha256: await fileHash(path),
          },
        },
      }),
    );
    const messages: string[] = [];
    const options = {
      input,
      output,
      work,
      selection,
      reserveBytes: 0,
      workers: 1,
      progress: (s: string) => {
        messages.push(s);
      },
    };
    await compilePartitioned(options);
    const progress = messages
      .map(compilerProgress)
      .filter((p) => p?.stage === "semantic-features");
    expect(progress.at(-1)).toMatchObject({ completed: 1, total: 1 });
    const reader = await new AtlasReader(
      new FileSource(Bun.file(output)),
    ).open();
    try {
      expect(reader.index.manifest.featureKinds).toEqual(["boundaries"]);
      expect(reader.index.manifest.capabilities).toContain(
        "administrative-boundaries",
      );
      expect(reader.index.manifest.capabilities).toContain("map-labels");
      expect((await boundaryCatalog(reader)).count).toBe(1);
      expect((await findBoundary(reader, "relation/100"))?.geometry).toEqual(
        boundary.geometry,
      );
      const keys = (await reader.allBlocks()).map((b) => b.key);
      expect(keys.some((k) => k.startsWith("features/water/"))).toBe(false);
      expect(keys.some((k) => k.startsWith("labels/settlements/"))).toBe(true);
    } finally {
      reader.dispose();
    }
    const hash = await fileHash(output);
    await compilePartitioned(options);
    expect(await fileHash(output)).toBe(hash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
