import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { PNG } from "pngjs";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import {
  familyCatalog,
  validateFamilies,
  type DataFamily,
} from "../packages/format/src/families";
import {
  planRasterAmendment,
  amendRasters,
  type RasterAmendment,
} from "../packages/provisioning/src/raster-amend";
import { composeCapabilities } from "../packages/provisioning/src/compose-capabilities";
import {
  installedCapabilities,
  familySelection,
} from "../packages/provisioning/src/families";
import { transportFixture, points } from "./helpers/transport-fixture";
import { AtlasEngine } from "../packages/operations/src/index";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { Preparations, type PreparationJob } from "../apps/server/preparations";
import { HostedLibrary } from "../apps/server/library";
import type { RasterLayer } from "../packages/format/src/raster";
beforeAll(async () =>
  initSync({
    module: await Bun.file(
      new URL(
        "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
        import.meta.url,
      ),
    ).arrayBuffer(),
  }),
);
const signal = () => new AbortController().signal;
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
async function fixture(largeManifest = false) {
  const f = await transportFixture(),
    dir = await mkdtemp("/tmp/atlas-raster-amend-");
  const custom: DataFamily = {
    id: "custom:survey",
    version: 1,
    schema: { id: "example/survey", version: 1 },
    encoding: "json",
    blockPrefix: "custom/",
    coverage: { bounds: [...f.manifest.bounds] },
    provenance: {
      url: "test",
      fingerprint: "b".repeat(64),
      attribution: "Survey",
    },
    dependencies: [],
  };
  const bytes = await encodePackage(
    {
      ...f.manifest,
      ...(largeManifest
        ? { limitations: ["Fixture provenance ".repeat(16000)] }
        : {}),
      capabilities: [...f.manifest.capabilities, "location-search"],
      families: [custom],
    },
    [
      ...f.inputs,
      {
        key: "search/locations",
        bytes: encode({
          schema: "locations-v1",
          records: [
            {
              id: "node/8",
              name: "River cafe",
              kind: "poi",
              category: "cafe",
              aliases: [],
              coordinates: points[0],
            },
          ],
        }),
      },
      {
        key: "custom/survey",
        bytes: Bun.gzipSync(encode({ observations: 7 })),
        codec: "gzip",
        rawLength: encode({ observations: 7 }).length,
      },
    ],
    { paged: true },
  );
  await Bun.write(dir + "/target.atlas", bytes);
  const target = await new AtlasReader(
    new FileSource(Bun.file(dir + "/target.atlas")),
  ).open();
  const image = new PNG({ width: 256, height: 256 });
  image.data.fill(155);
  const png = PNG.sync.write(image);
  const layer: RasterLayer = {
    id: "image",
    name: "Original survey",
    version: 1,
    kind: "imagery",
    crs: "EPSG:3857",
    matrix: "xyz",
    encoding: "png",
    tileSize: 256,
    minZoom: 0,
    maxZoom: 1,
    bounds: [0, 0, 180, 85],
    source: {
      url: "fixture:photo",
      attribution: "Independent photo",
      license: "Test",
    },
  };
  const rasterBytes = await encodePackage(
    {
      ...f.manifest,
      name: "Raster donor",
      source: {
        url: "fixture:photo",
        attribution: "Independent photo",
        sha256: "a".repeat(64),
      },
      bounds: layer.bounds,
      transport: undefined,
      capabilities: ["raster-rendering"],
      rasters: [layer],
    },
    [
      { key: "raster/image/0/0/0", bytes: png },
      { key: "raster/image/1/1/0", bytes: png },
      { key: "custom/do-not-import", bytes: encode("unrelated") },
    ],
    { paged: true },
  );
  await Bun.write(dir + "/donor.atlas", rasterBytes);
  const donor = await new AtlasReader(
      new FileSource(Bun.file(dir + "/donor.atlas")),
    ).open(),
    sources = new Map([["donor", donor]]);
  const request: RasterAmendment = {
    targetId: "target",
    targetSnapshot: target.index.manifest.snapshot,
    name: "Combined",
    maxBytes: 1024 ** 2,
    layers: [
      {
        id: "survey",
        name: "Survey",
        sourceId: "donor",
        sourceSnapshot: donor.index.manifest.snapshot,
        sourceLayer: "image",
      },
      {
        id: "second",
        name: "Second observation",
        sourceId: "donor",
        sourceSnapshot: donor.index.manifest.snapshot,
        sourceLayer: "image",
      },
    ],
  };
  const read = (path: string) =>
    new AtlasReader(new FileSource(Bun.file(path))).open();
  return {
    dir,
    f,
    target,
    donor,
    sources,
    request,
    bytes,
    rasterBytes,
    read,
    close: async () => {
      target.dispose();
      donor.dispose();
      f.reader.dispose();
      f.router.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("raster amendment preserves routing, search, compressed custom data and independent provenance in one offline file", async () => {
  const f = await fixture();
  let reader: AtlasReader | undefined, engine: AtlasEngine | undefined;
  try {
    const plan = await planRasterAmendment(f.target, f.sources, f.request);
    expect(plan.addition.blocks).toBe(4);
    expect(plan.layers[0]!.bounds).toEqual(f.target.index.manifest.bounds);
    await amendRasters(
      f.target,
      f.sources,
      f.request,
      f.dir + "/combined.atlas",
      signal(),
    );
    reader = await f.read(f.dir + "/combined.atlas");
    engine = new AtlasEngine(reader, async () => {});
    expect(reader.index.manifest.transport!.graphSnapshot).toBe(
      f.target.index.manifest.snapshot,
    );
    expect((await engine.route(points[0]!, points[2]!, "cycling")).status).toBe(
      "found",
    );
    expect(
      (await engine.isochrone(points[0]!, [30, 60], "cycling")).status,
    ).toBe("reachable");
    expect((await engine.search("River cafe")).matches[0]?.name).toBe(
      "River cafe",
    );
    const old = await f.target.allBlocks(),
      current = await reader.allBlocks();
    for (const b of old) {
      const n = current.find((n) => n.key === b.key)!;
      expect(n.hash).toBe(b.hash);
      expect(n.codec).toBe(b.codec);
      expect(n.rawLength).toBe(b.rawLength);
    }
    expect(current.some((b) => b.key === "custom/do-not-import")).toBe(false);
    expect(
      reader.index.manifest.families?.find((d) => d.id === "custom:survey"),
    ).toEqual(f.target.index.manifest.families![0]);
    expect(reader.index.manifest.rasters![0]!.source.attribution).toBe(
      "Independent photo",
    );
    expect(reader.index.manifest.rasters![0]!.provenance?.archiveSnapshot).toBe(
      f.donor.index.manifest.snapshot,
    );
    const tile = await reader.block("raster/survey/1/1/0");
    expect(tile).toEqual(await f.donor.block("raster/image/1/1/0"));
    await rm(f.dir + "/donor.atlas");
    await rm(f.dir + "/target.atlas");
    engine.destroy();
    reader.dispose();
    reader = await f.read(f.dir + "/combined.atlas");
    engine = new AtlasEngine(reader, async () => {});
    expect(await reader.block("raster/survey/1/1/0")).toEqual(tile);
    expect((await engine.route(points[0]!, points[2]!, "cycling")).status).toBe(
      "found",
    );
    expect((await engine.search("River cafe")).total).toBe(1);
  } finally {
    engine?.destroy();
    reader?.dispose();
    await f.close();
  }
});
test("removing and replacing raster layers preserves other families and stable layer IDs", async () => {
  const f = await fixture();
  const readers: AtlasReader[] = [];
  try {
    await amendRasters(
      f.target,
      f.sources,
      f.request,
      f.dir + "/first.atlas",
      signal(),
    );
    const first = await f.read(f.dir + "/first.atlas");
    readers.push(first);
    await amendRasters(
      first,
      f.sources,
      {
        ...f.request,
        targetSnapshot: first.index.manifest.snapshot,
        layers: [{ ...f.request.layers[0]!, name: "Replacement" }],
      },
      f.dir + "/second.atlas",
      signal(),
    );
    const second = await f.read(f.dir + "/second.atlas");
    readers.push(second);
    expect(second.index.manifest.rasters?.map((r) => r.id)).toEqual(["survey"]);
    expect(second.index.manifest.rasters![0]!.name).toBe("Replacement");
    expect(
      (await second.allBlocks()).some((b) =>
        b.key.startsWith("raster/second/"),
      ),
    ).toBe(false);
    expect(second.index.manifest.transport).toEqual(
      first.index.manifest.transport,
    );
    await amendRasters(
      second,
      new Map(),
      {
        ...f.request,
        targetSnapshot: second.index.manifest.snapshot,
        layers: [],
      },
      f.dir + "/none.atlas",
      signal(),
    );
    const none = await f.read(f.dir + "/none.atlas");
    readers.push(none);
    expect(none.index.manifest.capabilities).not.toContain("raster-rendering");
    expect(
      none.index.manifest.families?.some((f) => f.id.startsWith("raster:")),
    ).toBe(false);
    // Other capability edits must not leave stale raster descriptors.
    await composeCapabilities(
      first,
      undefined,
      {
        targetId: "target",
        targetSnapshot: first.index.manifest.snapshot,
        name: "One layer",
        capabilities: installedCapabilities(first.index.manifest).filter(
          (c) => c !== "raster:second",
        ),
        maxBytes: 1024 ** 2,
        paddingCells: 0,
      },
      [],
      f.dir + "/cap.atlas",
      signal(),
    );
    const cap = await f.read(f.dir + "/cap.atlas");
    readers.push(cap);
    expect(
      cap.index.manifest.families?.some((f) => f.id === "raster:second"),
    ).toBe(false);
  } finally {
    readers.forEach((r) => r.dispose());
    await f.close();
  }
});
test("plans reject stale inputs, duplicate IDs, absent layers and incompatible coverage", async () => {
  const f = await fixture();
  try {
    for (const request of [
      { ...f.request, targetSnapshot: "0".repeat(64) },
      { ...f.request, layers: [f.request.layers[0]!, f.request.layers[0]!] },
      {
        ...f.request,
        layers: [{ ...f.request.layers[0]!, sourceSnapshot: "0".repeat(64) }],
      },
      {
        ...f.request,
        layers: [{ ...f.request.layers[0]!, sourceLayer: "missing" }],
      },
      { ...f.request, layers: [{ id: "new", name: "Missing" }] },
      { ...f.request, maxBytes: 1 },
    ])
      await expect(
        planRasterAmendment(f.target, f.sources, request),
      ).rejects.toThrow();
    const saved = f.donor.index.manifest.rasters![0]!.bounds;
    f.donor.index.manifest.rasters![0]!.bounds = [-90, -20, -80, -10];
    await expect(
      planRasterAmendment(f.target, f.sources, f.request),
    ).rejects.toThrow("overlap");
    f.donor.index.manifest.rasters![0]!.bounds = saved;
  } finally {
    await f.close();
  }
});
test("cancelled or corrupt raster amendments leave published archives unchanged", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    await expect(
      amendRasters(
        f.target,
        f.sources,
        f.request,
        f.dir + "/out.atlas",
        abort.signal,
        (p) => {
          if (p.phase === "packing") abort.abort();
        },
      ),
    ).rejects.toThrow();
    expect(await Bun.file(f.dir + "/out.atlas").exists()).toBe(false);
    expect(
      (await readdir(f.dir)).filter(
        (n) => n.includes(".part") || n.includes(".lock"),
      ),
    ).toEqual([]);
    await Bun.write(f.dir + "/out.atlas", "existing");
    await expect(
      amendRasters(
        f.target,
        f.sources,
        f.request,
        f.dir + "/out.atlas",
        signal(),
      ),
    ).rejects.toThrow("immutable");
    expect(await Bun.file(f.dir + "/out.atlas").text()).toBe("existing");
    const original = f.donor.source.read.bind(f.donor.source);
    f.donor.source.read = async (a, b, s) => {
      const bytes = await original(a, b, s);
      if (a >= f.donor.index.header.payloadOffset) {
        bytes[0]! ^= 1;
      }
      return bytes;
    };
    await expect(
      amendRasters(
        f.target,
        f.sources,
        f.request,
        f.dir + "/corrupt.atlas",
        signal(),
      ),
    ).rejects.toThrow("Checksum");
    expect(await Bun.file(f.dir + "/target.atlas").bytes()).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
test("family catalog adapts legacy manifests and rejects duplicate/overlapping declarations", async () => {
  const f = await fixture();
  try {
    const catalog = familyCatalog(f.target.index.manifest);
    expect(catalog.some((f) => f.id === "routing:cycling")).toBe(true);
    expect(catalog.some((f) => f.id === "search")).toBe(true);
    validateFamilies(catalog);
    expect(() => validateFamilies([...catalog, catalog[0]])).toThrow();
    expect(() =>
      validateFamilies([{ ...catalog[0], coverage: { bounds: [1, 1, 0, 0] } }]),
    ).toThrow();
  } finally {
    await f.close();
  }
});
test("host queue pins all raster donors, protects inputs, retires old revision only on success and survives reopening", async () => {
  const f = await fixture(true);
  let manager: Preparations | undefined, library: HostedLibrary | undefined;
  try {
    manager = await Preparations.open(
      f.dir + "/host",
      f.dir + "/target.atlas",
      f.target.index.manifest,
    );
    const install = async (
      bytes: Uint8Array,
      manifest: typeof f.target.index.manifest,
    ) => {
      const id = crypto.randomUUID();
      await Bun.write(manager!.path(id), bytes);
      const job: PreparationJob = {
        id,
        name: manifest.name,
        manifest,
        size: bytes.length,
        state: "ready",
        createdAt: new Date().toISOString(),
        selection: familySelection(
          manifest,
          installedCapabilities(manifest),
          manifest.name,
          1024 ** 2,
          0,
        ),
        progress: {
          phase: "verifying",
          message: "ready",
          completed: 1,
          total: 1,
          readBytes: 0,
          writtenBytes: bytes.length,
        },
      };
      manager!.jobs.set(id, job);
      await Bun.write(f.dir + "/host/" + id + ".json", JSON.stringify(job));
      return job;
    };
    const target = await install(f.bytes, f.target.index.manifest),
      donor = await install(f.rasterBytes, f.donor.index.manifest),
      request = {
        ...f.request,
        targetId: target.id,
        layers: f.request.layers.map((l) => ({ ...l, sourceId: donor.id })),
      };
    const http = (path: string, origin = "http://localhost") =>
      new Request("http://localhost/admin/preparations/" + path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    expect(
      (await manager.handle(http("raster", "http://evil.test"), "127.0.0.1"))
        .status,
    ).toBe(403);
    expect(
      (await manager.handle(http("raster-plan"), "127.0.0.1")).status,
    ).toBe(200);
    const response = await manager.handle(http("raster"), "127.0.0.1");
    expect(response.status).toBe(202);
    const job = manager.jobs.get((await response.json()).id)!;
    expect(target.served).not.toBe(false);
    await expect(manager.delete(donor.id)).rejects.toThrow("active or queued");
    const end = performance.now() + 10000;
    while (!["ready", "failed"].includes(job.state)) {
      if (performance.now() > end) throw new Error("Queue timeout");
      await Bun.sleep(10);
    }
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    expect(target.served).toBe(false);
    expect(target.supersededBy).toBe(job.id);
    library = new HostedLibrary(
      manager,
      (r) => new AtlasEngine(r, async () => {}),
    );
    const route = await library.handle(
      new Request(`http://localhost/maps/${job.id}/api/route`, {
        method: "POST",
        body: JSON.stringify({
          snapshot: job.manifest!.snapshot,
          input: { start: points[0], end: points[2], profile: "cycling" },
        }),
      }),
    );
    expect(route!.status).toBe(200);
    expect((await route!.json()).result.status).toBe("found");
    await library.close();
    library = undefined;
    await manager.close();
    manager = await Preparations.open(
      f.dir + "/host",
      f.dir + "/target.atlas",
      f.target.index.manifest,
    );
    expect(manager.catalog().some((m) => m.id === job.id)).toBe(true);
    expect(manager.jobs.get(target.id)?.served).toBe(false);
  } finally {
    await library?.close();
    await manager?.close();
    await f.close();
  }
}, 15000);
