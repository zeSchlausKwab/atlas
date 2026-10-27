import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { FeatureCollection, Polygon } from "geojson";
import { parseHeader } from "../packages/format/src/index";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { buildFeatures } from "../packages/features/src/compile";
import { PagedFeatureWriter } from "../packages/features/src/paged-build";
import { AtlasFeatures, type Bounds } from "../packages/features/src/index";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import {
  readFeatureCell,
  featureCatalog,
  featureJSON,
  MAX_FEATURE_PAGE,
} from "../packages/features/src/pages";
import { preparePackage } from "../packages/provisioning/src/prepare";
import {
  planPreparation,
  type PackageSelection,
} from "../packages/provisioning/src/selection";

const bounds: Bounds = [16.37, 48.19, 16.4, 48.22];
const query: Bounds = [16.3795, 48.1995, 16.3835, 48.2035];
function building(id: number, x: number, y: number, points = 100) {
  const ring = Array.from({ length: points }, (_, i) => [
    x + Math.cos((i / points) * Math.PI * 2) * 0.00002,
    y + Math.sin((i / points) * Math.PI * 2) * 0.00002,
  ]);
  ring.push(ring[0]!);
  return {
    type: "Feature" as const,
    properties: {
      id: `way/${id}`,
      name: `Building ${id}`,
      class: 2,
      tags: { building: "yes", height: id % 2 ? "18" : "9" },
    },
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
}
const dense: FeatureCollection = {
  type: "FeatureCollection",
  features: Array.from({ length: 800 }, (_, i) =>
    building(
      i + 1,
      16.38 + (i % 30) * 0.0001,
      48.2 + Math.floor(i / 30) * 0.0001,
    ),
  ),
};
async function fixture(fc = dense, legacy = false) {
  const blocks: InputBlock[] = [];
  const writer = new PagedFeatureWriter({
    add: async (b) => {
      blocks.push(b);
    },
  });
  for (const [key, features] of buildFeatures(fc)) {
    if (legacy)
      blocks.push({
        key,
        bytes: featureJSON({ schema: "features-v1", features }),
      });
    else await writer.cell(key, features);
  }
  const bytes = await encodePackage(
    {
      format: "atlas",
      version: 1,
      name: "Dense features",
      source: {
        url: "fixture",
        sha256: "a".repeat(64),
        attribution: "OSM fixture",
      },
      bounds,
      minZoom: 0,
      maxZoom: 0,
      features: fc.features.length,
      peaks: 0,
      places: [],
      capabilities: ["feature-extraction"],
      limitations: [],
      featureZoom: 12,
      ...(!legacy ? { featureSchema: 2 as const } : {}),
      featureKinds: ["buildings"],
    },
    blocks,
    { paged: true },
  );
  const readKeys: string[] = [];
  let at = parseHeader(bytes.subarray(0, 32)).payloadOffset;
  const ranges = blocks.map((b) => {
    const r = { start: at, end: at + b.bytes.length, key: b.key };
    at = r.end;
    return r;
  });
  const source = new FileSource(new Blob([bytes]));
  const reader = await new AtlasReader({
    read: async (start, end) => {
      readKeys.push(
        ranges.find((r) => r.start === start && r.end === end)?.key ??
          "metadata",
      );
      return source.read(start, end);
    },
  }).open();
  return { reader, blocks, readKeys };
}
test("dense attribute workspace reads no footprint pages, retains exact results and works after sources close", async () => {
  const f = await fixture(),
    w = new AtlasWorkspace([f.reader]);
  const prepared = await w.prepare({
    bounds: query,
    families: ["buildings"],
    geometry: false,
    maxMemoryBytes: 2 * 1024 ** 2,
  });
  expect(prepared.records).toBe(800);
  expect(f.readKeys.some((k) => k.startsWith("features/attributes/"))).toBe(
    true,
  );
  expect(f.readKeys.some((k) => k.startsWith("features/geometry/"))).toBe(
    false,
  );
  expect(
    f.blocks.filter((b) => b.key.startsWith("features/geometry/")).length,
  ).toBeGreaterThan(5);
  expect(f.blocks.every((b) => b.bytes.length <= MAX_FEATURE_PAGE)).toBe(true);
  const reads = f.readKeys.length;
  f.reader.dispose();
  const tall = w.query({
    workspace: prepared.workspace,
    where: [{ field: "heightMeters", op: "gte", value: 18 }],
  });
  expect(tall.count).toBe(400);
  expect(
    w.result(tall.result, 0, 1, ["geometry", "geometryAvailable"]).rows[0],
  ).toEqual({ geometry: null, geometryAvailable: false });
  expect(f.readKeys.length).toBe(reads);
  const full = await fixture();
  await expect(
    new AtlasWorkspace([full.reader]).prepare({
      bounds: query,
      families: ["buildings"],
      maxMemoryBytes: 2 * 1024 ** 2,
    }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  full.reader.dispose();
});
test("boundary candidates read geometry and exclude a query wholly inside a courtyard", async () => {
  const shell = building(1, 16.38, 48.2, 4);
  shell.geometry = {
    type: "Polygon",
    coordinates: [
      [
        [16.38, 48.2],
        [16.39, 48.2],
        [16.39, 48.21],
        [16.38, 48.21],
        [16.38, 48.2],
      ],
      [
        [16.382, 48.202],
        [16.388, 48.202],
        [16.388, 48.208],
        [16.382, 48.208],
        [16.382, 48.202],
      ],
    ],
  };
  const f = await fixture({ type: "FeatureCollection", features: [shell] });
  const w = new AtlasWorkspace([f.reader]);
  const p = await w.prepare({
    bounds: [16.383, 48.203, 16.387, 48.207],
    families: ["buildings"],
    geometry: false,
  });
  expect(p.records).toBe(0);
  expect(f.readKeys.some((k) => k.startsWith("features/geometry/"))).toBe(true);
  f.reader.dispose();
});
test("pages prune distant clusters; mixed legacy and paged sources agree and deduplicate", async () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [building(1, 16.38, 48.2), building(2, 16.399, 48.219)],
  };
  const a = await fixture(fc),
    b = await fixture(fc, true);
  const w = new AtlasWorkspace([a.reader, b.reader]);
  const p = await w.prepare({
    bounds: query,
    families: ["buildings"],
    geometry: false,
  });
  expect(p.records).toBe(1);
  const all = await new AtlasFeatures(a.reader).query({
    kind: "buildings",
    bounds,
  });
  expect(all.features).toEqual(
    (await new AtlasFeatures(b.reader).query({ kind: "buildings", bounds }))
      .features,
  );
  a.reader.dispose();
  b.reader.dispose();
  const denseFixture = await fixture();
  const tiny: Bounds = [16.37997, 48.19997, 16.38023, 48.20023];
  const result = await new AtlasFeatures(denseFixture.reader).query({
    kind: "buildings",
    bounds: tiny,
  });
  expect(result.matched).toBe(9);
  expect(
    new Set(
      denseFixture.readKeys.filter((k) => k.startsWith("features/geometry/")),
    ).size,
  ).toBeLessThan(
    denseFixture.blocks.filter((b) => b.key.startsWith("features/geometry/"))
      .length,
  );
  denseFixture.reader.dispose();
});
test("a paged excerpt carries all referenced pages and can itself be excerpted", async () => {
  const f = await fixture();
  const dir = await mkdtemp("/tmp/atlas-feature-pages-");
  const selection: PackageSelection = {
    snapshot: f.reader.index.manifest.snapshot,
    name: "Excerpt",
    polygon: [
      [query[0], query[1]],
      [query[2], query[1]],
      [query[2], query[3]],
      [query[0], query[3]],
    ],
    minZoom: 0,
    maxZoom: 0,
    layers: [],
    placeNames: false,
    streetNames: false,
    pois: false,
    profiles: [],
    search: false,
    reverse: false,
    peaks: false,
    featureKinds: ["buildings"],
    paddingCells: 0,
    maxBytes: 32 * 1024 ** 2,
  };
  let child: AtlasReader | undefined, grandchild: AtlasReader | undefined;
  try {
    const plan = await planPreparation(f.reader, selection);
    expect(
      plan.blocks.some((b) => b.key.startsWith("features/geometry/")),
    ).toBe(true);
    await preparePackage(
      f.reader,
      selection,
      dir + "/child.atlas",
      new AbortController().signal,
      () => {},
    );
    f.reader.dispose();
    child = await new AtlasReader(
      new FileSource(Bun.file(dir + "/child.atlas")),
    ).open();
    expect(child.index.manifest.featureSchema).toBe(2);
    expect(
      (
        await new AtlasWorkspace([child]).prepare({
          bounds: query,
          families: ["buildings"],
          geometry: false,
        })
      ).records,
    ).toBe(800);
    await preparePackage(
      child,
      { ...selection, snapshot: child.index.manifest.snapshot },
      dir + "/grandchild.atlas",
      new AbortController().signal,
      () => {},
    );
    grandchild = await new AtlasReader(
      new FileSource(Bun.file(dir + "/grandchild.atlas")),
    ).open();
    expect(
      (
        await new AtlasFeatures(grandchild).query({
          kind: "buildings",
          bounds: query,
        })
      ).matched,
    ).toBe(800);
  } finally {
    f.reader.dispose();
    child?.dispose();
    grandchild?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("cache-only, cancellation, malformed catalogs and read budgets fail explicitly", async () => {
  const f = await fixture(),
    w = new AtlasWorkspace([f.reader]);
  const reads = f.readKeys.length;
  await expect(
    w.prepare({
      bounds: query,
      families: ["buildings"],
      geometry: false,
      cacheOnly: true,
    }),
  ).rejects.toMatchObject({ code: "missing_blocks" });
  expect(f.readKeys.length).toBe(reads);
  await expect(
    w.prepare({
      bounds: query,
      families: ["buildings"],
      geometry: false,
      maxReadBytes: 1,
    }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  await expect(
    w.prepare({ bounds: query, families: ["buildings"] }, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(() =>
    featureCatalog(
      featureJSON({
        schema: "features-paged-v2",
        pages: [
          {
            attributes: "search/locations",
            geometry: "features/geometry/16/0/0",
            bounds: query,
            count: 1,
          },
        ],
      }),
    ),
  ).toThrow();
  f.reader.dispose();
});

test("exact source ID lookup resolves an anchor in a polygon hole in legacy and paged cells", async () => {
  const outer = [
    [16.38, 48.2],
    [16.39, 48.2],
    [16.39, 48.21],
    [16.38, 48.21],
    [16.38, 48.2],
  ];
  const hole = [
    [16.384, 48.204],
    [16.384, 48.206],
    [16.386, 48.206],
    [16.386, 48.204],
    [16.384, 48.204],
  ];
  const shape: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "way/88", class: 2, tags: { building: "yes" } },
        geometry: { type: "Polygon", coordinates: [outer, hole] },
      },
    ],
  };
  for (const legacy of [false, true]) {
    const { reader, blocks } = await fixture(shape, legacy);
    const cell = blocks.find((b) =>
      b.key.startsWith("features/buildings/"),
    )!.key;
    const seed: Bounds = [16.3849, 48.2049, 16.3851, 48.2051];
    const normal = [];
    for await (const f of readFeatureCell(reader, cell, seed)) normal.push(f);
    expect(normal).toHaveLength(0);
    const byId = [];
    for await (const f of readFeatureCell(
      reader,
      cell,
      seed,
      true,
      undefined,
      undefined,
      "way/88",
    ))
      byId.push(f);
    expect(byId).toHaveLength(1);
    expect(byId[0]!.geometry).toEqual(shape.features[0]!.geometry);
  }
});

test("prepare filters attributes before requesting footprint pages and preserves the selected universe", async () => {
  const f = await fixture(),
    w = new AtlasWorkspace([f.reader]);
  const p = await w.prepare({
    bounds: query,
    families: ["buildings"],
    geometry: true,
    where: [{ field: "heightMeters", op: "gte", value: 100 }],
  });
  expect(p.records).toBe(0);
  expect(f.readKeys.some((k) => k.startsWith("features/geometry/"))).toBe(
    false,
  );
  expect(w.query({ workspace: p.workspace }).coverage.selection).toEqual([
    { field: "heightMeters", op: "gte", value: 100 },
  ]);
  f.reader.dispose();
});
