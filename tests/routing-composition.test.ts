import { OperationSession } from "../apps/web/src/operations";
import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter } from "../packages/routing/src/paged";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import {
  project,
  TRANSPORT_MODES,
  type Manifest,
} from "../packages/format/src/index";
import { preparePackage } from "../packages/provisioning/src/prepare";
import { copyTransport } from "../packages/cli/src/shared-transport";
import { DiskWriter } from "../packages/cli/src/disk-writer";
import type { PackageSelection } from "../packages/provisioning/src/selection";
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
const points: [number, number][] = [
  [16, 48],
  [16.02, 48],
  [16.04, 48],
  [16.06, 48],
  [16.08, 48],
];
async function fixture() {
  const inputs: InputBlock[] = [],
    profiles: any = {};
  for (const [mode, name] of TRANSPORT_MODES.entries()) {
    const groups = new Map<number, number[]>(),
      y = Math.floor(project(16, 48)[1] * 16384);
    for (let id = 0; id < 4; id++)
      for (
        let x = Math.floor(project(...points[id]!)[0] * 16384);
        x <= Math.floor(project(...points[id + 1]!)[0] * 16384);
        x++
      )
        groups.set(x, [...(groups.get(x) ?? []), id]);
    for (const [x, ids] of groups) {
      const nodes = [...new Set(ids.flatMap((id) => [id, id + 1]))].sort(
          (a, b) => a - b,
        ),
        bytes = new Uint8Array(36 + nodes.length * 24 + ids.length * 32),
        v = new DataView(bytes.buffer);
      bytes.set(new TextEncoder().encode("RCL2"));
      v.setUint32(4, 14, true);
      v.setUint32(8, x, true);
      v.setUint32(12, y, true);
      bytes.set(new TextEncoder().encode("RTE2"), 16);
      v.setUint32(20, nodes.length, true);
      v.setUint32(24, ids.length, true);
      v.setUint32(32, mode, true);
      nodes.forEach((id, i) => {
        const p = 36 + i * 24;
        v.setBigInt64(p, BigInt(100 + id), true);
        v.setFloat64(p + 8, points[id]![0], true);
        v.setFloat64(p + 16, points[id]![1], true);
      });
      ids.forEach((id, i) => {
        const p = 36 + nodes.length * 24 + i * 28;
        v.setUint32(p, nodes.indexOf(id), true);
        v.setUint32(p + 4, nodes.indexOf(id + 1), true);
        v.setBigInt64(p + 8, BigInt(200 + id), true);
        v.setUint8(p + 16, 3);
        v.setFloat32(p + 20, [1200, 500, 200][mode]!, true);
        v.setFloat32(p + 24, [1200, 500, 200][mode]!, true);
        v.setUint32(36 + nodes.length * 24 + ids.length * 28 + i * 4, id, true);
      });
      inputs.push({ key: `routing/${name}/cells/14/${x}/${y}`, bytes });
    }
    profiles[name] = {
      prefix: `routing/${name}/cells`,
      zoom: 14,
      count: groups.size,
      codec: "rcl2",
      nodes: 5,
      segments: 4,
      turns: 0,
      skippedWays: 0,
      unsupportedRestrictions: 0,
      excludedRestrictionWays: 0,
    };
  }
  const manifest: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name: "Seam fixture",
    source: { url: "fixture", sha256: "0".repeat(64), attribution: "test" },
    bounds: [15.9, 47.9, 16.2, 48.2],
    minZoom: 0,
    maxZoom: 16,
    features: 0,
    peaks: 0,
    places: [],
    capabilities: ["transport-routing"],
    limitations: [],
    transport: { version: 1, profiles },
  };
  const bytes = await encodePackage(manifest, inputs, { paged: true });
  return { bytes, manifest, inputs, reader: await open(bytes) };
}
const open = (bytes: Uint8Array) =>
  new AtlasReader(
    new FileSource(new Blob([bytes as Uint8Array<ArrayBuffer>])),
  ).open();
function selection(snapshot: string, box: number[]): PackageSelection {
  const [w, s, e, n] = box as [number, number, number, number];
  return {
    snapshot,
    name: "Slice",
    polygon: [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ],
    minZoom: 0,
    maxZoom: 16,
    layers: [],
    featureKinds: [],
    placeNames: false,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    profiles: [...TRANSPORT_MODES],
    paddingCells: 0,
    maxBytes: 1048576,
  };
}
test("all modes cross a real cell seam, preserve nested graph provenance, and replay without reads", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-composition-test-");
  try {
    const readers: AtlasReader[] = [];
    for (const [i, box] of [
      [15.99, 47.99, 16.041, 48.01],
      [16.039, 47.99, 16.09, 48.01],
    ].entries()) {
      const path = dir + `/${i}.atlas`;
      await preparePackage(
        f.reader,
        selection(f.reader.index.manifest.snapshot, box),
        path,
        new AbortController().signal,
        () => {},
      );
      readers.push(
        await new AtlasReader(new FileSource(Bun.file(path))).open(),
      );
    }
    const nested = dir + "/nested.atlas";
    await preparePackage(
      readers[0]!,
      selection(
        readers[0]!.index.manifest.snapshot,
        [15.995, 47.995, 16.04, 48.005],
      ),
      nested,
      new AbortController().signal,
      () => {},
    );
    const child = await new AtlasReader(
      new FileSource(Bun.file(nested)),
    ).open();
    expect(child.index.manifest.transport?.graphSnapshot).toBe(
      f.reader.index.manifest.snapshot,
    );
    child.dispose();
    const provider = new RoutingComposition(
      readers.map((reader, i) => ({ id: String(i), reader })),
    );
    for (const mode of TRANSPORT_MODES) {
      const router = new PagedRouter(
        provider.snapshot,
        (key) => provider.read(key),
        () => {},
        async () => {},
      );
      const result = await router.route(
        points[0]!,
        points[4]!,
        mode,
        provider.prefix(mode),
      );
      expect(result.status).toBe("found");
      expect(
        new Set([...provider.served.values()].map((v) => v.source)),
      ).toEqual(new Set(["0", "1"]));
      const before = readers.map((r) => r.requests);
      readers.forEach((r) => (r.offline = true));
      const again = await router.route(
        points[0]!,
        points[4]!,
        mode,
        provider.prefix(mode),
      );
      expect(again.status).toBe("found");
      expect(readers.map((r) => r.requests)).toEqual(before);
      readers.forEach((r) => (r.offline = false));
      router.destroy();
    }
    const onlyWest = new RoutingComposition([
      { id: "west", reader: readers[0]! },
    ]);
    const eastKey = f.inputs.find(
      (b) =>
        b.key.startsWith("routing/driving") &&
        Number(b.key.split("/")[4]) ===
          Math.floor(project(16.08, 48)[0] * 16384),
    )!.key;
    expect((await onlyWest.read(eastKey)).missing).toBe(true);
    readers.forEach((r) => r.dispose());
  } finally {
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("rejects incompatible graph identities and conflicting overlapping cells", async () => {
  const f = await fixture(),
    changed = await open(
      await encodePackage({ ...f.manifest, name: "Other compile" }, f.inputs, {
        paged: true,
      }),
    );
  expect(
    () =>
      new RoutingComposition([
        { id: "a", reader: f.reader },
        { id: "b", reader: changed },
      ]),
  ).toThrow("shared compiled graph");
  const inputs = f.inputs.map((b, i) =>
    i ? b : { ...b, bytes: b.bytes.slice() },
  );
  inputs[0]!.bytes[48] ^= 1;
  const conflict = await open(
    await encodePackage(
      {
        ...f.manifest,
        transport: {
          ...f.manifest.transport!,
          graphSnapshot: f.reader.index.manifest.snapshot,
        },
      },
      inputs,
      { paged: true },
    ),
  );
  await expect(
    new RoutingComposition([
      { id: "a", reader: f.reader },
      { id: "bad", reader: conflict },
    ]).read(inputs[0]!.key),
  ).rejects.toThrow("Conflicting cells");
  for (const r of [f.reader, changed, conflict]) r.dispose();
});
test("shared transport compilation copies exact cells and keeps root identity", async () => {
  const f = await fixture(),
    dir = await mkdtemp("/tmp/atlas-copy-graph-");
  try {
    await Bun.write(dir + "/source.atlas", f.bytes);
    const writer = await new DiskWriter(dir + "/copy.atlas", 1048576).open();
    const transport = await copyTransport(
      writer,
      dir + "/source.atlas",
      selection("unused", [15.99, 47.99, 16.09, 48.01]),
    );
    await writer.finish({ ...f.manifest, transport });
    const reader = await new AtlasReader(
      new FileSource(Bun.file(dir + "/copy.atlas")),
    ).open();
    expect(transport.graphSnapshot).toBe(f.reader.index.manifest.snapshot);
    for (const b of f.inputs)
      expect(await reader.block(b.key)).toEqual(await f.reader.block(b.key));
    reader.dispose();
  } finally {
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("routing budgets are bounded before allocating WASM state", () => {
  for (const budget of [
    { searchStates: 0 },
    { searchStates: 2_000_001 },
    { cellBytes: 0 },
    { cellBytes: 257 * 1048576 },
    { searchStates: NaN },
  ])
    expect(
      () =>
        new PagedRouter(
          "test",
          async () => ({ empty: true, fetchedBytes: 0 }),
          () => {},
          async () => {},
          budget,
        ),
    ).toThrow("Invalid routing budget");
});

test("unavailable copies fall back to another compatible host; a cold offline cache is missing, not empty", async () => {
  const f = await fixture();
  const copy = await open(f.bytes);
  try {
    f.reader.offline = true;
    const provider = new RoutingComposition([
      { id: "offline", reader: f.reader },
      { id: "online", reader: copy },
    ]);
    const key = f.inputs[0]!.key;
    expect((await provider.read(key)).bytes).toBeDefined();
    expect(provider.served.get(key)?.source).toBe("online");
    expect(
      (
        await new RoutingComposition([
          { id: "offline", reader: f.reader },
        ]).read(key)
      ).missing,
    ).toBe(true);
  } finally {
    f.reader.dispose();
    copy.dispose();
  }
});

test("workspace composition keeps scoped queries separate from shared routing permissions", async () => {
  const f = await fixture();
  const focus = await open(
    await encodePackage(
      {
        ...f.manifest,
        name: "Query-only source",
        transport: undefined,
        capabilities: ["peak-query"],
        peaks: 1,
      },
      [
        {
          key: "query/peaks",
          bytes: new TextEncoder().encode(
            JSON.stringify([
              {
                id: "peak",
                name: "Scoped peak",
                coordinates: [16, 48],
                elevation: 1234,
              },
            ]),
          ),
        },
      ],
    ),
  );
  const session = new OperationSession(focus, () => {}, [
    { id: "query", reader: focus },
    { id: "network", reader: f.reader },
  ]);
  session.configure("device", ["routing", "queries"]);
  expect(session.routingAvailable).toBe(true);
  expect(session.transportProfiles).toEqual(["walking", "cycling", "driving"]);
  expect(session.composition?.sources.map((s) => s.id)).toEqual(["network"]);
  expect((await session.peak()).peak?.name).toBe("Scoped peak");
  expect(f.reader.options.purposes).not.toContain("queries");
  session.configure("device", ["queries"]);
  expect(session.routingAvailable).toBe(false);
  expect(f.reader.options.purposes).not.toContain("routing");
  expect(() => session.route(points[0]!, points[4]!)).toThrow("disabled");
  session.configure("device", ["routing"]);
  expect(() => session.peak()).toThrow("disabled");
  session.mode = "server";
  expect(session.routingAvailable).toBe(false);
  expect(() => session.route(points[0]!, points[4]!)).toThrow("not available");
  expect(() => session.isochrone(points[0]!, [60])).toThrow("not available");
  session.destroy();
  focus.dispose();
  f.reader.dispose();
});
test("workspace refuses a mixed graph before launching a worker or reading route payloads", async () => {
  const a = await fixture(),
    b = await fixture();
  b.reader.index.manifest.transport!.graphSnapshot = "f".repeat(64);
  const session = new OperationSession(a.reader, () => {}, [
    { id: "a", reader: a.reader },
    { id: "b", reader: b.reader },
  ]);
  const reads = a.reader.requests + b.reader.requests;
  expect(session.routingAvailable).toBe(false);
  expect(() => session.route(points[0]!, points[4]!)).toThrow("not compatible");
  expect(a.reader.requests + b.reader.requests).toBe(reads);
  session.destroy();
  a.reader.dispose();
  b.reader.dispose();
});
