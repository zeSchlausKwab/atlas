import { test, expect, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { packComposition } from "../packages/provisioning/src/composition";
import {
  openMembers,
  MemberSource,
  validateComposition,
} from "../packages/format/src/composition";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import { transportFixture, points } from "./helpers/transport-fixture";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { AtlasRouter } from "../packages/routing/src/index";
import { Preparations, type PreparationJob } from "../apps/server/preparations";
import { HostedLibrary } from "../apps/server/library";
import { AtlasEngine } from "../packages/operations/src/index";
import {
  familySelection,
  installedCapabilities,
} from "../packages/provisioning/src/families";
import { preparePackage } from "../packages/provisioning/src/prepare";
import { PNG } from "pngjs";
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
const read = (bytes: Uint8Array) =>
  new AtlasReader(new FileSource(new Blob([new Uint8Array(bytes)]))).open();
test("single-file composition preserves all member bytes and routing without original sources", async () => {
  const f = await transportFixture(),
    dir = await mkdtemp("/tmp/atlas-composition-");
  const blob = crypto.getRandomValues(new Uint8Array(65536));
  const opaque = await encodePackage(
    {
      ...f.manifest,
      name: "Custom member",
      capabilities: [],
      transport: undefined,
    },
    [{ key: "custom/opaque", bytes: blob }],
  );
  const custom = await read(opaque);
  const output = dir + "/combined.atlas";
  try {
    await packComposition(
      [f.reader, custom],
      "Combined",
      output,
      20 * 1024 ** 2,
      signal(),
      () => {},
    );
    f.reader.dispose();
    custom.dispose();
    const parent = await new AtlasReader(
      new FileSource(Bun.file(output)),
    ).open();
    const members = await openMembers(parent);
    expect(members).toHaveLength(2);
    expect(await members[1]!.reader.block("custom/opaque")).toEqual(blob);
    const router = new AtlasRouter(members[0]!.reader, async () => {});
    const route = await router.route(points[0]!, points[2]!, "walking");
    expect(route).toBeDefined();
    expect(
      await new MemberSource(
        parent,
        parent.index.manifest.composition!.members[1]!,
      ).read(0, opaque.length),
    ).toEqual(opaque);
    await expect(
      packComposition(
        members.map((m) => m.reader),
        "Again",
        output,
        20 * 1024 ** 2,
        signal(),
        () => {},
      ),
    ).rejects.toThrow("already exists");
    await expect(
      packComposition(
        [parent],
        "Nested",
        dir + "/nested.atlas",
        20 * 1024 ** 2,
        signal(),
        () => {},
      ),
    ).rejects.toThrow("ordinary");
    members.forEach((m) => m.reader.dispose());
    parent.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("member descriptor and range validation reject malformed requests", async () => {
  expect(() =>
    validateComposition({
      version: 1,
      members: [{ id: "../bad", snapshot: "0".repeat(64), bytes: 10 }],
    }),
  ).toThrow();
  const s = new MemberSource({} as AtlasReader, {
    id: "m0",
    snapshot: "0".repeat(64),
    bytes: 10,
  });
  await expect(s.read(-1, 5)).rejects.toThrow("range");
  await expect(s.read(0, 11)).rejects.toThrow("range");
});
test("queued composition protects inputs and serves member-specific tools", async () => {
  const f = await transportFixture(),
    dir = await mkdtemp("/tmp/atlas-composition-host-");
  const input = await encodePackage(f.manifest, f.inputs, { paged: true });
  await Bun.write(dir + "/base.atlas", input);
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/base.atlas",
    f.reader.index.manifest,
  );
  const id = crypto.randomUUID();
  await Bun.write(manager.path(id), input);
  manager.jobs.set(id, {
    id,
    name: "Source",
    createdAt: new Date().toISOString(),
    state: "ready",
    manifest: f.reader.index.manifest,
    size: input.length,
    selection: familySelection(
      f.reader.index.manifest,
      installedCapabilities(f.reader.index.manifest),
      "Source",
      20 * 1024 ** 2,
      0,
    ),
    progress: {
      phase: "packing",
      message: "Ready",
      completed: 1,
      total: 1,
      readBytes: 0,
      writtenBytes: input.length,
    },
  });
  const library = new HostedLibrary(manager, (r) => new AtlasEngine(r));
  try {
    const job = await manager.createComposition({
      name: "Hosted combination",
      inputs: [{ id, snapshot: f.reader.index.manifest.snapshot }],
      allowStorageRisk: true,
    });
    await expect(manager.delete(id)).rejects.toThrow("active or queued");
    const deadline = Date.now() + 20000;
    while (!["ready", "failed"].includes(job.state) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    const response = await library.handle(
      new Request(
        `http://localhost/maps/${job.id}/api/members/m0/capabilities`,
      ),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("X-Atlas-Snapshot")).toBe(
      f.reader.index.manifest.snapshot,
    );
    await manager.delete(id); // Parent data can be deleted after packing.
    const reopened = await new AtlasReader(
      new FileSource(Bun.file(manager.path(job.id))),
    ).open();
    expect((await openMembers(reopened))[0]!.manifest.snapshot).toBe(
      f.reader.index.manifest.snapshot,
    );
    reopened.dispose();
  } finally {
    await library.close();
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("raster-region preparation retains selected pixel bytes and independent attribution", async () => {
  const f = await transportFixture(),
    dir = await mkdtemp("/tmp/atlas-raster-region-");
  const pixel = PNG.sync.write(new PNG({ width: 256, height: 256 }));
  const raster: RasterLayer = {
    version: 1,
    id: "photo",
    name: "Photo",
    kind: "imagery",
    crs: "EPSG:3857",
    matrix: "xyz",
    tileSize: 256,
    minZoom: 0,
    maxZoom: 0,
    bounds: [...f.manifest.bounds],
    encoding: "png",
    source: { url: "fixture", attribution: "Imagery author", license: "CC0" },
  };
  const bytes = await encodePackage(
    {
      ...f.manifest,
      transport: undefined,
      tileLayers: [],
      capabilities: ["raster-rendering"],
      rasters: [raster],
    },
    [{ key: "raster/photo/0/0/0", bytes: pixel }],
  );
  const reader = await read(bytes);
  try {
    const s = familySelection(
      reader.index.manifest,
      ["raster:photo"],
      "Raster region",
      20 * 1024 ** 2,
      0,
    );
    s.polygon = [
      [16, 48],
      [16.01, 48],
      [16.01, 48.01],
      [16, 48.01],
    ];
    await preparePackage(reader, s, dir + "/region.atlas", signal(), () => {});
    const region = await new AtlasReader(
      new FileSource(Bun.file(dir + "/region.atlas")),
    ).open();
    expect(await region.block("raster/photo/0/0/0")).toEqual(
      new Uint8Array(pixel),
    );
    expect(region.index.manifest.capabilities).toEqual(["raster-rendering"]);
    expect(region.index.manifest.rasters?.[0]?.source.attribution).toBe(
      "Imagery author",
    );
    region.dispose();
  } finally {
    reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
