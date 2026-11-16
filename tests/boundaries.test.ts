import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { Feature, MultiPolygon } from "geojson";
import { BoundaryWriter } from "../packages/boundaries/src/build";
import {
  boundaryCatalog,
  containingBoundaries,
  findBoundary,
  readBoundaries,
} from "../packages/boundaries/src/index";
import { boundaryOperation } from "../packages/boundaries/src/tools";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { AtlasEngine } from "../packages/operations/src/index";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { preparePackage } from "../packages/provisioning/src/prepare";
import {
  availability,
  type PackageSelection,
} from "../packages/provisioning/src/selection";
import { workspaceFixture } from "./helpers/workspace-fixture";
const signal = () => new AbortController().signal;
const ring = (a: number, b: number, c: number, d: number) => [
  [a, b],
  [c, b],
  [c, d],
  [a, d],
  [a, b],
];
const district: Feature<MultiPolygon> = {
  type: "Feature",
  id: "relation/10",
  properties: {
    id: "relation/10",
    name: "Test district",
    boundaryRefs: ["node/1"],
    tags: {
      type: "boundary",
      boundary: "administrative",
      admin_level: "9",
      name: "Test district",
      "name:de": "Testbezirk",
    },
  },
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [ring(16, 48, 16.08, 48.08), ring(16.03, 48.03, 16.05, 48.05)],
      [ring(16.09, 48.09, 16.1, 48.1)],
    ],
  },
};
async function fixture(
  features: Feature[] = [district],
  onRead?: (e: import("../packages/format/src/reader").ReadEvent) => void,
) {
  const blocks: InputBlock[] = [],
    writer = new BoundaryWriter({
      add: async (b) => {
        blocks.push(b);
      },
    });
  for (const f of features) await writer.add(f);
  await writer.finish();
  const bytes = await encodePackage(
    {
      format: "atlas",
      version: 1,
      name: "Boundary fixture",
      source: {
        url: "fixture",
        sha256: "a".repeat(64),
        attribution: "Synthetic",
      },
      bounds: [16, 48, 16.2, 48.2],
      minZoom: 0,
      maxZoom: 16,
      features: 0,
      peaks: 0,
      places: [],
      featureZoom: 12,
      featureSchema: 2,
      featureKinds: ["boundaries"],
      capabilities: ["feature-extraction", "administrative-boundaries"],
      limitations: [],
    },
    blocks,
    { paged: true },
  );
  return new AtlasReader(new FileSource(new Blob([bytes])), onRead).open();
}
test("one stored polygon preserves holes, detached islands and explicit label links", async () => {
  const reader = await fixture();
  expect((await boundaryCatalog(reader)).count).toBe(1);
  expect(
    (await reader.allBlocks()).filter((b) =>
      b.key.startsWith("boundaries/geometry/"),
    ),
  ).toHaveLength(1);
  expect(
    (await containingBoundaries(reader, [16.01, 48.01])).features.map(
      (f) => f.id,
    ),
  ).toEqual(["relation/10"]);
  expect(
    (await containingBoundaries(reader, [16.04, 48.04])).features,
  ).toHaveLength(0);
  expect(
    (await containingBoundaries(reader, [16.095, 48.095])).features,
  ).toHaveLength(1);
  expect((await findBoundary(reader, "node/1"))!.id).toBe("relation/10");
  expect(await findBoundary(reader, "node/999")).toBeUndefined();
  const before = reader.requests;
  reader.offline = true;
  expect(
    (await containingBoundaries(reader, [16.01, 48.01])).features,
  ).toHaveLength(1);
  expect(reader.requests).toBe(before);
  reader.dispose();
});
test("attribute-only boundary workspace skips geometry when envelope contains the whole object", async () => {
  const seen: string[] = [],
    reader = await fixture([district], (e) => seen.push(e.key));
  const ws = new AtlasWorkspace([reader], "interactive");
  const p = await ws.prepare({
    bounds: [16, 48, 16.2, 48.2],
    families: ["boundaries"],
    geometry: false,
  });
  expect(p.records).toBe(1);
  expect(seen.some((k) => k.startsWith("boundaries/geometry/"))).toBe(false);
  const q = ws.query({
    workspace: p.workspace,
    where: [{ field: "tags.admin_level", op: "eq", value: "9" }],
  });
  expect(q.count).toBe(1);
  ws.clear();
  reader.dispose();
});
test("exact intersection excludes a bounds query inside an administrative hole", async () => {
  const r = await fixture(),
    found = [];
  for await (const f of readBoundaries(
    r,
    [16.035, 48.035, 16.045, 48.045],
    false,
  ))
    found.push(f);
  expect(found).toHaveLength(0);
  r.dispose();
});
test("client chat and server registry resolve the same boundary across overlapping packages", async () => {
  const a = await fixture(),
    b = await fixture(),
    runtime = new ChatDataRuntime([a, b]);
  const hit = await runtime.invoke(
    "boundary_search",
    { query: "Testbezirk" },
    signal(),
  );
  expect(hit.matches).toHaveLength(1);
  const shape = await runtime.invoke(
    "place_geometry",
    { result: hit.result, id: "relation/10", family: "boundaries" },
    signal(),
  );
  expect(shape.boundaryAvailable).toBe(true);
  expect(
    (await runtime.resolve(shape.result)).collection.features[0]!.geometry,
  ).toEqual(district.geometry);
  const local = await runtime.invoke(
    "boundary_lookup",
    { point: [16.01, 48.01] },
    signal(),
  );
  const engine = new AtlasEngine(a),
    ref = engine.registry.catalog().find((x) => x.id === "boundary_lookup")!;
  const remote: any = await engine.registry.invoke(ref, {
    point: [16.01, 48.01],
  });
  expect((await runtime.resolve(local.result)).collection.features).toEqual(
    remote.features,
  );
  expect(remote.administrativeHierarchy).toBe(false);
  engine.destroy();
  a.dispose();
  b.dispose();
});
test("extracting an archive keeps whole intersecting boundaries and links, but omission removes capability", async () => {
  const reader = await fixture(),
    dir = await mkdtemp("/tmp/atlas-boundaries-");
  const selection: PackageSelection = {
    snapshot: reader.index.manifest.snapshot,
    name: "Slice",
    polygon: ring(16.001, 48.001, 16.02, 48.02).slice(0, -1) as [
      number,
      number,
    ][],
    minZoom: 0,
    maxZoom: 16,
    layers: [],
    profiles: [],
    featureKinds: ["boundaries"],
    placeNames: false,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    paddingCells: 0,
    maxBytes: 1024 ** 2,
  };
  try {
    await preparePackage(
      reader,
      selection,
      dir + "/slice.atlas",
      signal(),
      () => {},
    );
    const slice = await new AtlasReader(
      new FileSource(Bun.file(dir + "/slice.atlas")),
    ).open();
    expect(availability(slice.index.manifest).featureKinds).toEqual([
      "boundaries",
    ]);
    expect((await findBoundary(slice, "node/1"))!.geometry).toEqual(
      district.geometry,
    );
    slice.dispose();
  } finally {
    reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("old archives do not advertise boundaries and ambiguous label links require exact IDs", async () => {
  const { reader: legacy } = await workspaceFixture();
  delete legacy.index.manifest.featureKinds;
  expect(availability(legacy.index.manifest).featureKinds).not.toContain(
    "boundaries",
  );
  await expect(
    boundaryOperation([legacy], "boundary_search", { query: "Test" }, signal()),
  ).rejects.toThrow("no retained administrative boundaries");
  const second = structuredClone(district);
  second.id = "relation/11";
  second.properties!.id = second.id;
  const r = await fixture([district, second]);
  await expect(findBoundary(r, "node/1")).rejects.toThrow(
    "multiple administrative areas",
  );
  expect((await findBoundary(r, "relation/10"))!.id).toBe("relation/10");
  r.dispose();
  legacy.dispose();
});
test("unclosed boundaries and duplicate identities fail instead of inventing polygons", async () => {
  const broken = structuredClone(district);
  broken.geometry.coordinates[0]![0]!.pop();
  await expect(fixture([broken])).rejects.toThrow("Unclosed");
  await expect(fixture([district, district])).rejects.toThrow("Duplicate");
});
test("metadata pages remain bounded across hundreds of areas", async () => {
  const features = Array.from({ length: 270 }, (_, i) => {
    const f = structuredClone(district);
    f.id = `relation/${1000 + i}`;
    f.properties!.id = f.id;
    return f;
  });
  const r = await fixture(features),
    catalog = await boundaryCatalog(r);
  expect(catalog.count).toBe(270);
  expect(catalog.pages.map((p) => p.count)).toEqual([256, 14]);
  expect((await findBoundary(r, "relation/1269"))!.id).toBe("relation/1269");
  r.dispose();
});

test("boundary upgrade preserves legacy blocks and rejects another snapshot or incomplete coverage", async () => {
  const { upgradeBoundaries } = await import(
    "../packages/boundaries/src/upgrade"
  );
  const { reader: original, bytes } = await workspaceFixture();
  const source = await fixture();
  const dir = await mkdtemp("/tmp/atlas-upgrade-");
  try {
    const output = dir + "/upgraded.atlas";
    const report = await upgradeBoundaries(original, source, output, signal());
    expect(report.boundaries).toBe(1);
    const next = await new AtlasReader(new FileSource(Bun.file(output))).open();
    try {
      expect(next.index.manifest.snapshot).not.toBe(
        original.index.manifest.snapshot,
      );
      expect(next.index.manifest.featureSchema).toBe(
        original.index.manifest.featureSchema,
      );
      expect(next.index.manifest.featureKinds).toEqual([
        "buildings",
        "boundaries",
      ]);
      for (const b of await original.allBlocks()) {
        const copied = (await next.allBlocks()).find((n) => n.key === b.key)!;
        expect(copied.hash).toBe(b.hash);
        expect(copied.codec).toBe(b.codec);
        expect(await next.block(b.key)).toEqual(await original.block(b.key));
      }
      const runtime = new ChatDataRuntime([next]);
      const p = await runtime.invoke(
        "workspace_prepare",
        {
          bounds: [16, 48, 16.02, 48.02],
          families: ["buildings"],
          geometry: true,
        },
        signal(),
      );
      expect(p.records).toBe(1);
      runtime.clear();
      expect((await findBoundary(next, "relation/10"))!.geometry).toEqual(
        district.geometry,
      );
    } finally {
      next.dispose();
    }
    expect(await original.source.read(0, bytes.length)).toEqual(bytes);
    await expect(
      upgradeBoundaries(original, source, output, signal()),
    ).rejects.toThrow("immutable");
    source.index.manifest.source.sha256 = "b".repeat(64);
    await expect(
      upgradeBoundaries(original, source, dir + "/wrong.atlas", signal()),
    ).rejects.toThrow("same source snapshot");
    source.index.manifest.source.sha256 = "a".repeat(64);
    source.index.manifest.bounds = [16, 48, 16.005, 48.005];
    await expect(
      upgradeBoundaries(original, source, dir + "/narrow.atlas", signal()),
    ).rejects.toThrow("does not cover");
    expect(await Bun.file(dir + "/narrow.atlas").exists()).toBe(false);
  } finally {
    original.dispose();
    source.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("administrative-depth excerpts omit finer geometry reads and preserve country geometry exactly", async () => {
  const country = structuredClone(district);
  country.id = "relation/20";
  country.properties!.id = country.id;
  country.properties!.tags.admin_level = "2";
  country.properties!.boundaryRefs = [];
  const reads: string[] = [];
  const reader = await fixture([country, district], (e) => reads.push(e.key));
  const dir = await mkdtemp("/tmp/atlas-boundary-depth-");
  try {
    const selection: PackageSelection = {
      snapshot: reader.index.manifest.snapshot,
      name: "Countries only",
      polygon: ring(16, 48, 16.2, 48.2).slice(0, -1) as [number, number][],
      minZoom: 0,
      maxZoom: 6,
      layers: [],
      profiles: [],
      featureKinds: ["boundaries"],
      boundaryMaxAdminLevel: 2,
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
      paddingCells: 0,
      maxBytes: 1024 ** 2,
    };
    await preparePackage(
      reader,
      selection,
      dir + "/country.atlas",
      signal(),
      () => {},
    );
    const slice = await new AtlasReader(
      new FileSource(Bun.file(dir + "/country.atlas")),
    ).open();
    try {
      expect((await boundaryCatalog(slice)).count).toBe(1);
      expect((await findBoundary(slice, "relation/20"))!.geometry).toEqual(
        country.geometry,
      );
      expect(await findBoundary(slice, "relation/10")).toBeUndefined();
      expect(slice.index.manifest.limitations.join(" ")).toContain(
        "admin_level 1–2",
      );
      expect(reads).not.toContain("boundaries/geometry/1");
    } finally {
      slice.dispose();
    }
  } finally {
    reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boundary writer filters numbered levels without silently classifying missing levels", async () => {
  const unknown = structuredClone(district);
  delete unknown.properties!.tags.admin_level;
  const blocks: InputBlock[] = [];
  const filtered = new BoundaryWriter(
    {
      add: async (b) => {
        blocks.push(b);
      },
    },
    8,
  );
  await filtered.add(district);
  await filtered.add(unknown);
  await filtered.finish();
  expect(filtered.count).toBe(0);
  const unrestricted = new BoundaryWriter({ add: async () => {} });
  await unrestricted.add(unknown);
  expect(unrestricted.count).toBe(1);
});
