import { beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import type { Manifest } from "../packages/format/src/index";
import { encodeTile } from "../packages/cli/src/tile-codec";
import {
  amendRouting,
  planRoutingAmendment,
  type RoutingAmendment,
} from "../packages/provisioning/src/amend";
import { AtlasEngine } from "../packages/operations/src/index";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { transportFixture, points } from "./helpers/transport-fixture";
import { Preparations, type PreparationJob } from "../apps/server/preparations";
import { HostedLibrary } from "../apps/server/library";

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
async function fixture() {
  const donor = await transportFixture();
  // A real display tile plus an extension unknown to the amendment implementation.
  const geometry = encodeTile([
    {
      type: 3,
      tags: { class: 1 },
      geometry: [
        [
          [0, 0],
          [4096, 0],
          [4096, 4096],
          [0, 4096],
          [0, 0],
        ],
      ],
    } as any,
  ]);
  const tileBytes = Bun.gzipSync(geometry as Uint8Array<ArrayBuffer>);
  const inputs: InputBlock[] = [
    {
      key: "tile/water/0/0/0",
      bytes: tileBytes,
      codec: "gzip",
      rawLength: geometry.length,
      z: 0,
      x: 0,
      y: 0,
      features: 1,
    },
    {
      key: "custom/demo",
      bytes: new TextEncoder().encode(
        "Extension data stays exactly as written.",
      ),
    },
  ];
  const manifest = {
    ...donor.manifest,
    name: "Geometry first",
    transport: undefined,
    capabilities: ["vector-rendering"],
    tileLayers: ["water" as const],
    features: 1,
  };
  const bytes = await encodePackage(manifest, inputs, { paged: true });
  const target = await new AtlasReader(
    new FileSource(new Blob([bytes])),
  ).open();
  const options: RoutingAmendment = {
    name: "Geometry plus cycling",
    targetSnapshot: target.index.manifest.snapshot,
    sourceSnapshot: donor.reader.index.manifest.snapshot,
    profiles: ["cycling"],
    paddingCells: 1,
    maxBytes: 1024 ** 2,
  };
  return {
    donor,
    target,
    bytes,
    inputs,
    manifest,
    options,
    close: () => {
      donor.router.destroy();
      target.dispose();
      donor.reader.dispose();
    },
  };
}
async function changed(reader: AtlasReader, changes: Partial<Manifest>) {
  const blocks: InputBlock[] = [];
  for await (const b of reader.iterateBlocks()) {
    const start = reader.index.header.payloadOffset + b.offset;
    blocks.push({
      ...b,
      bytes: await reader.source.read(start, start + b.length),
    });
  }
  const { snapshot, ...manifest } = reader.index.manifest;
  const bytes = await encodePackage({ ...manifest, ...changes }, blocks, {
    paged: true,
  });
  return new AtlasReader(new FileSource(new Blob([bytes]))).open();
}

test("amendment reuses compressed and unknown blocks; routes and isochrones work from the new standalone file", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-amend-");
  try {
    const plan = await planRoutingAmendment(
      f.target,
      f.donor.reader,
      f.options,
    );
    expect(plan.reuse.blocks).toBe(2);
    expect(plan.addition.cells.cycling).toBeGreaterThan(0);
    expect(f.donor.reader.bytesByPurpose.routing).toBe(0); // plan reads directory only
    const progress: string[] = [];
    const out = await amendRouting(
      f.target,
      f.donor.reader,
      f.options,
      dir + "/new.atlas",
      signal(),
      (p) => progress.push(p.phase),
    );
    const reader = await new AtlasReader(
      new FileSource(Bun.file(dir + "/new.atlas")),
    ).open();
    const engine = new AtlasEngine(reader, async () => {});
    try {
      expect(out.manifest.snapshot).not.toBe(f.options.targetSnapshot);
      expect(out.manifest.amendment?.parentSnapshot).toBe(
        f.options.targetSnapshot,
      );
      expect(out.manifest.transport?.graphSnapshot).toBe(
        f.options.sourceSnapshot,
      );
      expect(out.manifest.bounds).toEqual(f.manifest.bounds);
      expect(out.manifest.tileLayers).toEqual(["water"]);
      expect(Object.keys(out.manifest.transport!.profiles)).toEqual([
        "cycling",
      ]);
      for (const b of await f.target.allBlocks()) {
        const next = (await reader.allBlocks()).find((x) => x.key === b.key)!;
        expect(next.hash).toBe(b.hash);
        expect(next.codec).toBe(b.codec);
        expect(next.rawLength).toBe(b.rawLength);
        expect(await reader.block(b.key)).toEqual(await f.target.block(b.key));
      }
      const route = await engine.route(points[0]!, points[2]!, "cycling");
      expect(route.status).toBe("found");
      expect(route.status === "found" && route.seconds).toBe(80);
      expect(
        (await engine.isochrone(points[0]!, [30, 60], "cycling")).status,
      ).toBe("reachable");
      expect(f.target.index.manifest.transport).toBeUndefined();
      expect(progress).toContain("packing");
      expect(progress).toContain("verifying");
      expect(await readdir(dir)).toEqual(["new.atlas"]);
      await expect(
        amendRouting(
          f.target,
          f.donor.reader,
          f.options,
          dir + "/new.atlas",
          signal(),
        ),
      ).rejects.toThrow("immutable");
    } finally {
      engine.destroy();
      reader.dispose();
    }
  } finally {
    f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("planner rejects stale identity, missing modes, source changes, inadequate coverage and output budget", async () => {
  const f = await fixture();
  try {
    for (const options of [
      { ...f.options, targetSnapshot: "bad" },
      { ...f.options, sourceSnapshot: "bad" },
      { ...f.options, profiles: [] },
      { ...f.options, profiles: ["cycling", "cycling"] },
      { ...f.options, paddingCells: 5 },
      { ...f.options, maxBytes: 0 },
    ])
      await expect(
        planRoutingAmendment(
          f.target,
          f.donor.reader,
          options as RoutingAmendment,
        ),
      ).rejects.toThrow();
    const other = await changed(f.donor.reader, {
      source: { ...f.donor.manifest.source, sha256: "1".repeat(64) },
    });
    await expect(
      planRoutingAmendment(f.target, other, {
        ...f.options,
        sourceSnapshot: other.index.manifest.snapshot,
      }),
    ).rejects.toThrow("same source PBF");
    other.dispose();
    const small = await changed(f.donor.reader, {
      bounds: [15.99, 47.99, 16.01, 48.01],
    });
    await expect(
      planRoutingAmendment(f.target, small, {
        ...f.options,
        sourceSnapshot: small.index.manifest.snapshot,
      }),
    ).rejects.toThrow("entire target polygon");
    small.dispose();
    // Bounding boxes alone are insufficient: a donor polygon can omit part of the map.
    const triangle = await changed(f.donor.reader, {
      selection: {
        parentSnapshot: f.options.sourceSnapshot,
        polygon: [
          [15.9, 47.9],
          [16.1, 47.9],
          [16.1, 48.1],
        ],
        boundaryPolicy: "fixture",
      },
    });
    await expect(
      planRoutingAmendment(f.target, triangle, {
        ...f.options,
        sourceSnapshot: triangle.index.manifest.snapshot,
      }),
    ).rejects.toThrow("entire target polygon");
    triangle.dispose();
    await expect(
      planRoutingAmendment(f.target, f.target, {
        ...f.options,
        sourceSnapshot: f.target.index.manifest.snapshot,
      }),
    ).rejects.toThrow("construction pass");
  } finally {
    f.close();
  }
});

test("adding another mode preserves existing graph identity and rejects an independently compiled graph", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-amend-profiles-");
  try {
    await amendRouting(
      f.target,
      f.donor.reader,
      f.options,
      dir + "/cycling.atlas",
      signal(),
    );
    const target = await new AtlasReader(
      new FileSource(Bun.file(dir + "/cycling.atlas")),
    ).open();
    const options = {
      ...f.options,
      targetSnapshot: target.index.manifest.snapshot,
      profiles: ["walking" as const],
    };
    const wrong = await changed(f.donor.reader, {
      transport: {
        ...f.donor.manifest.transport!,
        graphSnapshot: "f".repeat(64),
      },
    });
    await expect(
      planRoutingAmendment(target, wrong, {
        ...options,
        sourceSnapshot: wrong.index.manifest.snapshot,
      }),
    ).rejects.toThrow("compiled graph identity");
    wrong.dispose();
    await expect(
      planRoutingAmendment(target, f.donor.reader, {
        ...options,
        profiles: ["cycling"],
      }),
    ).rejects.toThrow("already exists");
    const result = await amendRouting(
      target,
      f.donor.reader,
      options,
      dir + "/both.atlas",
      signal(),
    );
    expect(Object.keys(result.manifest.transport!.profiles).sort()).toEqual([
      "cycling",
      "walking",
    ]);
    expect(result.manifest.transport!.graphSnapshot).toBe(
      f.options.sourceSnapshot,
    );
    expect(result.manifest.transport!.profiles.cycling).toEqual(
      target.index.manifest.transport!.profiles.cycling,
    );
    target.dispose();
  } finally {
    f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled or corrupt amendments remove partial output and preserve inputs", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-amend-failure-");
  try {
    const controller = new AbortController();
    await expect(
      amendRouting(
        f.target,
        f.donor.reader,
        f.options,
        dir + "/cancel.atlas",
        controller.signal,
        (p) => {
          if (p.phase === "packing") controller.abort();
        },
      ),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    const corruptBytes = f.bytes.slice(),
      b = (await f.target.allBlocks()).find((b) => b.key === "custom/demo")!;
    corruptBytes[f.target.index.header.payloadOffset + b.offset] ^= 1;
    const corrupt = await new AtlasReader(
      new FileSource(new Blob([corruptBytes])),
    ).open();
    await expect(
      amendRouting(
        corrupt,
        f.donor.reader,
        f.options,
        dir + "/bad.atlas",
        signal(),
      ),
    ).rejects.toThrow("checksum mismatch");
    corrupt.dispose();
    expect(await readdir(dir)).toEqual([]);
    await expect(
      amendRouting(
        f.target,
        f.donor.reader,
        f.options,
        dir + "/space.atlas",
        signal(),
        () => {},
        async () => {
          throw new Error("Free space exhausted");
        },
      ),
    ).rejects.toThrow("Free space");
    expect(await readdir(dir)).toEqual([]);
    expect(await f.target.block("custom/demo")).toEqual(f.inputs[1]!.bytes);
  } finally {
    f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("publication cannot overwrite or delete a concurrently created output", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-amend-race-");
  const output = dir + "/new.atlas";
  try {
    await expect(
      amendRouting(
        f.target,
        f.donor.reader,
        f.options,
        output,
        signal(),
        (p) => {
          if (p.phase === "verifying")
            writeFileSync(output, "another publisher's file", { flag: "wx" });
        },
      ),
    ).rejects.toThrow("EEXIST");
    expect(await Bun.file(output).text()).toBe("another publisher's file");
    expect(await readdir(dir)).toEqual(["new.atlas"]);
  } finally {
    f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function until(test: () => boolean) {
  const deadline = Date.now() + 12000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Queue did not settle");
    await Bun.sleep(10);
  }
}
test("host amendment uses the persistent queue, protects dependencies and serves the new routing revision", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-amend-host-");
  let manager: Preparations | undefined, library: HostedLibrary | undefined;
  try {
    const sourcePath = dir + "/source.atlas";
    await Bun.write(
      sourcePath,
      await encodePackage(f.donor.manifest, f.donor.inputs, { paged: true }),
    );
    manager = await Preparations.open(
      dir + "/hosted",
      sourcePath,
      f.donor.reader.index.manifest,
    );
    const id = crypto.randomUUID();
    const selection = {
      snapshot: f.options.sourceSnapshot,
      name: "Geometry first",
      polygon: [
        [15.9, 47.9],
        [16.1, 47.9],
        [16.1, 48.1],
        [15.9, 48.1],
      ] as [number, number][],
      minZoom: 0,
      maxZoom: 0,
      layers: ["water" as const],
      placeNames: false,
      streetNames: false,
      pois: false,
      profiles: [],
      search: false,
      reverse: false,
      peaks: false,
      featureKinds: [],
      paddingCells: 1,
      maxBytes: 1024 ** 2,
    };
    const target: PreparationJob = {
      id,
      name: "Geometry first",
      state: "ready",
      createdAt: new Date().toISOString(),
      selection,
      manifest: f.target.index.manifest,
      size: f.bytes.length,
      progress: {
        phase: "verifying",
        message: "ready",
        completed: 1,
        total: 1,
        readBytes: 0,
        writtenBytes: f.bytes.length,
      },
    };
    await Bun.write(manager.path(id), f.bytes);
    await Bun.write(`${dir}/hosted/${id}.json`, JSON.stringify(target));
    manager.jobs.set(id, target);
    const request = (action: string, body: unknown) =>
      new Request(`http://localhost/admin/preparations/${action}`, {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const donorId = crypto.randomUUID();
    const donorJob: PreparationJob = {
      ...target,
      id: donorId,
      name: "Routing donor",
      manifest: f.donor.reader.index.manifest,
    };
    await Bun.write(manager.path(donorId), Bun.file(sourcePath));
    await Bun.write(`${dir}/hosted/${donorId}.json`, JSON.stringify(donorJob));
    manager.jobs.set(donorId, donorJob);
    const options = { ...f.options, targetId: id, sourceId: donorId };
    expect(
      (await manager.handle(request("amend-plan", options), "127.0.0.1"))
        .status,
    ).toBe(200);
    const response = await manager.handle(
      request("amend", options),
      "127.0.0.1",
    );
    expect(response.status).toBe(202);
    const job: PreparationJob = await response.json();
    await expect(manager.delete(id)).rejects.toThrow(
      "used by an active or queued",
    );
    await until(() =>
      ["ready", "failed"].includes(manager!.jobs.get(job.id)!.state),
    );
    expect(manager.jobs.get(job.id)!.error).toBeUndefined();
    expect(manager.jobs.get(job.id)!.state).toBe("ready");
    expect(await Bun.file(manager.path(id)).arrayBuffer()).toEqual(
      f.bytes.buffer,
    );
    library = new HostedLibrary(
      manager,
      (reader) => new AtlasEngine(reader, async () => {}),
    );
    const route = await library.handle(
      new Request(`http://localhost/maps/${job.id}/api/route`, {
        method: "POST",
        body: JSON.stringify({
          snapshot: manager.jobs.get(job.id)!.manifest!.snapshot,
          input: { start: points[0], end: points[2], profile: "cycling" },
        }),
      }),
    );
    expect(route!.status).toBe(200);
    expect((await route!.json()).result.status).toBe("found");
    const saved = await Bun.file(`${dir}/hosted/${job.id}.json`).json();
    expect(saved.amendment.targetId).toBe(id);
    expect(manager.catalog()).toHaveLength(3);
  } finally {
    await library?.close();
    await manager?.close();
    f.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
