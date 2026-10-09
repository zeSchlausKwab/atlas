import { test, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { PbfSources } from "../apps/server/pbf-sources";
import {
  coveringRegion,
  importBounds,
  parseRegions,
  allowedPbfUrl,
  planMatches,
  WORLD_SOURCE,
  type PbfPlan,
} from "../packages/provisioning/src/global-source";
import {
  validateSelectionScope,
  type PackageSelection,
} from "../packages/provisioning/src/selection";
import { downloadPbf } from "../packages/provisioning/src/download";
import { runCompiler } from "../packages/provisioning/src/process";
import {
  importPbf,
  validateImportSize,
} from "../packages/provisioning/src/import-pbf";
import { preparePackage } from "../packages/provisioning/src/prepare";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
const MiB = 1048576;
const rect = (
  w: number,
  s: number,
  e: number,
  n: number,
): [number, number][] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
];
const ring = (w: number, s: number, e: number, n: number) => [
  ...rect(w, s, e, n),
  [w, s],
];
const region = (id: string, coordinates: number[][][]) => ({
  type: "Feature",
  properties: {
    id,
    name: id,
    urls: { pbf: `https://download.geofabrik.de/europe/${id}-latest.osm.pbf` },
  },
  geometry: { type: "Polygon", coordinates },
});
const catalog = {
  type: "FeatureCollection",
  features: [
    region("parent", [ring(-2, -2, 2, 2)]),
    region("child", [ring(-1, -1, 1, 1), ring(-0.2, -0.2, 0.2, 0.2)]),
  ],
};
const area = {
  polygon: rect(0.3, 0.3, 0.4, 0.4),
  paddingCells: 1,
  profiles: [],
  maxSourceBytes: MiB,
};
const recipe: PackageSelection = {
  snapshot: "geofabrik",
  name: "Global fixture",
  polygon: rect(15.99, 47.99, 16.01, 48.01),
  minZoom: 0,
  maxZoom: 16,
  layers: ["roads"],
  placeNames: false,
  streetNames: false,
  pois: false,
  profiles: ["cycling"],
  search: false,
  reverse: false,
  peaks: false,
  featureKinds: [],
  paddingCells: 1,
  maxBytes: 16 * MiB,
};
const plan = (bytes: number): PbfPlan => ({
  id: crypto.randomUUID(),
  provider: "geofabrik",
  region: {
    id: "fixture",
    name: "Fixture",
    url: "https://download.geofabrik.de/europe/fixture-261008.osm.pbf",
  },
  bytes,
  etag: '"fixture"',
  lastModified: "Thu, 08 Oct 2026 12:00:00 GMT",
  expiresAt: Date.now() + 100000,
  area: { ...area, polygon: recipe.polygon, profiles: recipe.profiles },
  bounds: importBounds({
    ...area,
    polygon: recipe.polygon,
    profiles: recipe.profiles,
  }),
});
const mock = (body: Uint8Array, p: PbfPlan, status = 200) =>
  new Response(new Uint8Array(body), {
    status,
    headers: {
      "content-length": String(p.bytes),
      etag: p.etag!,
      "last-modified": p.lastModified,
    },
  });
test("covering sources account for holes, full bounds, and routing padding", () => {
  const regions = parseRegions(catalog);
  expect(coveringRegion(regions, [0.3, 0.3, 0.4, 0.4]).id).toBe("child");
  expect(coveringRegion(regions, [-0.4, -0.4, 0.4, 0.4]).id).toBe("parent");
  expect(() => coveringRegion(regions, [2, 2, 3, 3])).toThrow("No single");
  const plain = importBounds(area),
    route = importBounds({ ...area, profiles: ["walking"] });
  expect(route[0]).toBeLessThan(plain[0]);
  expect(route[2]).toBeGreaterThan(plain[2]);
  for (const u of [
    "http://download.geofabrik.de/europe/x.osm.pbf",
    "https://localhost/x.osm.pbf",
    "https://download.geofabrik.de@127.0.0.1/x.osm.pbf",
    "https://download.geofabrik.de/a.osm.pbf?url=bad",
  ])
    expect(() => allowedPbfUrl(u)).toThrow();
  expect(() => validateSelectionScope(recipe, WORLD_SOURCE)).not.toThrow();
  const p = plan(3);
  expect(planMatches(p, recipe, MiB)).toBe(true);
  expect(planMatches(p, { ...recipe, profiles: [] }, MiB)).toBe(false);
  expect(planMatches(p, { ...recipe, paddingCells: 2 }, MiB)).toBe(false);
  expect(planMatches(p, recipe, 2 * MiB)).toBe(false);
  expect(() =>
    validateImportSize({ ...p, bounds: [-120, -60, 120, 60] }, recipe),
  ).toThrow("500,000");
});
test("source planning pins a dated redirect, caps downloads and rejects unsafe redirects", async () => {
  const seen: string[] = [];
  let bytes = 100;
  const fetcher = async (url: RequestInfo | URL) => {
    seen.push(String(url));
    if (String(url).endsWith("json")) return Response.json(catalog);
    if (String(url).includes("latest"))
      return new Response(null, {
        status: 307,
        headers: { location: "/europe/child-261008.osm.pbf" },
      });
    return new Response(null, {
      headers: {
        "content-length": String(bytes),
        "last-modified": "Thu, 08 Oct 2026 12:00:00 GMT",
        etag: '"v1"',
      },
    });
  };
  const sources = new PbfSources(fetcher),
    p = await sources.plan(area);
  expect(p.region.id).toBe("child");
  expect(p.region.url).toEndWith("child-261008.osm.pbf");
  expect(p.etag).toBe('"v1"');
  expect(sources.get(p.id)).toEqual(p);
  bytes = MiB + 1;
  await expect(sources.plan(area)).rejects.toThrow("download limit");
  expect(seen.filter((u) => u.endsWith("json"))).toHaveLength(1);
  expect(() => sources.get("unknown")).toThrow("expired");
  const bad = new PbfSources(async (url: RequestInfo | URL) =>
    String(url).endsWith("json")
      ? Response.json(catalog)
      : new Response(null, {
          status: 307,
          headers: { location: "http://127.0.0.1/private.osm.pbf" },
        }),
  );
  await expect(bad.plan(area)).rejects.toThrow("Untrusted");
});
test("PBF downloads stream to disk, enforce identity/size and reuse verified sources", async () => {
  const dir = await mkdtemp("/tmp/atlas-source-download-"),
    body = new Uint8Array([1, 2, 3]),
    p = plan(body.length);
  try {
    let calls = 0;
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect((init!.headers as any)["If-Match"]).toBe(p.etag);
      expect(init!.redirect).toBe("error");
      return mock(body, p);
    };
    const result = await downloadPbf(
      p,
      dir,
      new AbortController().signal,
      () => {},
      fetcher,
    );
    expect(result.cached).toBe(false);
    expect(result.receipt.sha256).toHaveLength(64);
    expect(
      (
        await downloadPbf(
          p,
          dir,
          new AbortController().signal,
          () => {},
          fetcher,
        )
      ).cached,
    ).toBe(true);
    expect(calls).toBe(1);
    await Bun.write(result.path, new Uint8Array([3, 2, 1]));
    await expect(
      downloadPbf(p, dir, new AbortController().signal, () => {}, fetcher),
    ).rejects.toThrow("verification");
    for (const [name, data, message] of [
      ["short", new Uint8Array([1]), "truncated"],
      ["long", new Uint8Array([1, 2, 3, 4]), "budget"],
    ] as const) {
      const sub = dir + "/" + name;
      await expect(
        downloadPbf(
          p,
          sub,
          new AbortController().signal,
          () => {},
          async () => mock(data, p),
        ),
      ).rejects.toThrow(message);
      expect(await readdir(sub)).toEqual([]);
    }
    await expect(
      downloadPbf(
        p,
        dir + "/changed",
        new AbortController().signal,
        () => {},
        async () =>
          new Response(new Uint8Array(body), {
            headers: { "content-length": "3", etag: '"new"' },
          }),
      ),
    ).rejects.toThrow("changed");
    const abort = new AbortController();
    await expect(
      downloadPbf(
        p,
        dir + "/cancelled",
        abort.signal,
        () => abort.abort(),
        async () => mock(body, p),
      ),
    ).rejects.toThrow();
    expect(await readdir(dir + "/cancelled")).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cancelling a compiler terminates its subprocesses", async () => {
  const abort = new AbortController();
  let pid = 0;
  await expect(
    runCompiler(
      [
        process.execPath,
        "-e",
        `const c=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"ignore",stderr:"ignore"}); console.log(c.pid); setInterval(()=>{},1000);`,
      ],
      process.cwd(),
      abort.signal,
      (line) => {
        pid = Number(line);
        abort.abort();
      },
    ),
  ).rejects.toThrow();
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    if (Date.now() > deadline)
      throw new Error("Compiler descendant survived cancellation");
    await new Promise((r) => setTimeout(r, 10));
  }
});
test("real PBF crop and selective compiler keep only cycling, roads and chosen source capabilities", async () => {
  const dir = await mkdtemp("/tmp/atlas-global-pipeline-"),
    body = new Uint8Array(
      await Bun.file("tests/fixtures/transport.osm.pbf").arrayBuffer(),
    ),
    p = plan(body.length),
    phases: string[] = [];
  try {
    await downloadPbf(
      p,
      dir + "/cache",
      new AbortController().signal,
      () => {},
      async () => mock(body, p),
    );
    const source = await importPbf(
      p,
      recipe,
      dir + "/cache",
      dir + "/work",
      new AbortController().signal,
      (p) => phases.push(p.phase),
    );
    const reader = await new AtlasReader(
      new FileSource(Bun.file(source)),
    ).open();
    await preparePackage(
      reader,
      { ...recipe, snapshot: reader.index.manifest.snapshot },
      dir + "/map.atlas",
      new AbortController().signal,
      () => {},
    );
    const out = await new AtlasReader(
        new FileSource(Bun.file(dir + "/map.atlas")),
      ).open(),
      m = out.index.manifest;
    expect(m.source.url).toBe(p.region.url);
    expect(m.source.inputs![0]!.bytes).toBe(body.length);
    expect(m.source.extraction?.strategy).toContain("smart");
    expect(m.source.extraction?.sourceDate).toBe("2026-10-08");
    expect(m.capabilities).toEqual(["vector-rendering", "transport-routing"]);
    expect(m.tileLayers).toEqual(["roads"]);
    expect(Object.keys(m.transport!.profiles)).toEqual(["cycling"]);
    const blocks = await out.allBlocks();
    expect(blocks.some((b) => b.key.startsWith("tile/roads/16/"))).toBe(true);
    expect(blocks.some((b) => b.key.startsWith("routing/cycling/cells/"))).toBe(
      true,
    );
    expect(
      blocks.every(
        (b) =>
          b.key.startsWith("tile/roads/") ||
          b.key.startsWith("routing/cycling/"),
      ),
    ).toBe(true);
    expect(phases).toContain("extracting");
    expect(phases).toContain("compiling");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
