import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { addPartitionedTransport } from "../packages/cli/src/transport-partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import {
  sha256,
  project,
  unproject,
  TRANSPORT_MODES,
  type Manifest,
} from "../packages/format/src/index";
import {
  OSM_ROUTING_CONTRACT,
  ownsRoutingCell,
  type RoutingFederation,
} from "../packages/format/src/routing-contract";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter, readRoutingCell } from "../packages/routing/src/paged";
import { preparePackage } from "../packages/provisioning/src/prepare";

type Box = [number, number, number, number];
let work: string;
let packages: Awaited<ReturnType<typeof build>>[] = [];
const cx = Math.floor(project(16, 48)[0] * 16384),
  cy = Math.floor(project(16, 48)[1] * 16384);
const point = (x: number, y = 0) =>
  unproject((cx + x + 0.5) / 16384, (cy + y + 0.5) / 16384);
const box = (w: number, e: number): Box => {
  const lo = unproject((cx + w) / 16384, (cy + 5) / 16384),
    hi = unproject((cx + e) / 16384, (cy - 2) / 16384);
  return [lo[0], lo[1], hi[0], hi[1]];
};
const polygon = (b: Box): [number, number][] => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[2], b[3]],
  [b[0], b[3]],
];
const open = (bytes: Uint8Array) =>
  new AtlasReader(
    new FileSource(new Blob([bytes as Uint8Array<ArrayBuffer>])),
  ).open();
async function command(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([
    p.exited,
    new Response(p.stderr).text(),
  ]);
  if (code) throw new Error(`${args[0]}: ${err}`);
}
async function build(id: string, bounds: Box, authority: string) {
  const pbf = `${work}/${id}.osm.pbf`;
  await command([
    "osmium",
    "extract",
    `${work}/source.osm.pbf`,
    `--bbox=${bounds.join(",")}`,
    "--strategy=smart",
    "-S",
    "types=restriction",
    "-o",
    pbf,
  ]);
  const inputs: InputBlock[] = [];
  const federation: RoutingFederation = {
    version: 1,
    namespace: "openstreetmap",
    sourceRevision: authority,
    contract: OSM_ROUTING_CONTRACT,
    segmentIdentity: "osm-way-segment-v1",
    completeBounds: bounds,
  };
  const transport = await addPartitionedTransport(
    {
      async add(b) {
        inputs.push(b);
      },
    },
    pbf,
    `${work}/${id}-work`,
    TRANSPORT_MODES,
    new AbortController().signal,
    () => {},
    await sha256(new Uint8Array(await Bun.file(pbf).arrayBuffer())),
    federation,
  );
  const manifest: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name: id,
    source: { url: "synthetic-osm", sha256: authority, attribution: "test" },
    bounds,
    minZoom: 0,
    maxZoom: 0,
    features: 0,
    peaks: 0,
    places: [],
    capabilities: ["transport-routing"],
    limitations: [],
    transport,
  };
  const bytes = await encodePackage(manifest, inputs, { paged: true });
  return { manifest, inputs, bytes, reader: await open(bytes), pbf };
}
beforeAll(async () => {
  await command([
    "cargo",
    "build",
    "--release",
    "-p",
    "atlas-osm-import",
    "--bin",
    "transport-partitioned",
  ]);
  work = await mkdtemp("/tmp/atlas-federation-");
  initSync({
    module: await Bun.file(
      "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
    ).arrayBuffer(),
  });
  // Independent two-node ways ensure the west/east source PBFs and local ordinals differ.
  // A multi-segment way + walking-only branch exercise original index/profile independence.
  let xml = '<osm version="0.6" generator="atlas-federation-test">';
  const node = (x: number, y: number) => 1 + y * 13 + x;
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 13; x++) {
      const [lon, lat] = point(x, y);
      xml += `<node id="${node(x, y)}" version="1" lon="${lon}" lat="${lat}"/>`;
    }
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 12; x++)
      xml += `<way id="${100 + y * 12 + x}" version="1"><nd ref="${node(x, y)}"/><nd ref="${node(x + 1, y)}"/><tag k="highway" v="residential"/></way>`;
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 13; x++)
      xml += `<way id="${200 + y * 13 + x}" version="1"><nd ref="${node(x, y)}"/><nd ref="${node(x, y + 1)}"/><tag k="highway" v="residential"/></way>`;
  xml += `<way id="300" version="1"><nd ref="${node(5, 0)}"/><nd ref="${node(5, 0)}"/><nd ref="${node(5, 1)}"/><nd ref="${node(5, 2)}"/><tag k="highway" v="footway"/></way>`;
  xml += `<relation id="400" version="1"><member type="way" ref="105" role="from"/><member type="node" ref="${node(6, 0)}" role="via"/><member type="way" ref="106" role="to"/><tag k="type" v="restriction"/><tag k="restriction" v="no_straight_on"/><tag k="except" v="bicycle"/></relation></osm>`;
  await Bun.write(`${work}/source.osm`, xml);
  await command([
    "osmium",
    "cat",
    `${work}/source.osm`,
    "-o",
    `${work}/source.osm.pbf`,
  ]);
  const authority = await sha256(
    new Uint8Array(await Bun.file(`${work}/source.osm.pbf`).arrayBuffer()),
  );
  packages = [
    await build("whole", box(-2, 15), authority),
    await build("west", box(-2, 9), authority),
    await build("east", box(4, 15), authority),
  ];
}, 120000);
afterAll(async () => {
  for (const p of packages) p.reader.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});
function router(provider: RoutingComposition) {
  return new PagedRouter(
    provider.snapshot,
    (key) => provider.read(key),
    () => {},
    async () => {},
  );
}
test("independent PBF builds cross hosts with identical route costs and isochrones, including seam restrictions", async () => {
  const [whole, west, east] = packages;
  expect(
    await sha256(new Uint8Array(await Bun.file(west!.pbf).arrayBuffer())),
  ).not.toBe(
    await sha256(new Uint8Array(await Bun.file(east!.pbf).arrayBuffer())),
  );
  const combined = new RoutingComposition([
    { id: "west", reader: west!.reader },
    { id: "east", reader: east!.reader },
  ]);
  expect(combined.compatibility).toBe("osm-source");
  expect(west!.reader.index.manifest.transport!.graphSnapshot).toBeUndefined();
  expect(east!.reader.index.manifest.snapshot).not.toBe(
    west!.reader.index.manifest.snapshot,
  );
  const reference = new RoutingComposition([
    { id: "whole", reader: whole!.reader },
  ]);
  const a = router(combined),
    b = router(reference);
  try {
    for (const mode of TRANSPORT_MODES) {
      const expected = await b.route(
        point(0),
        point(12),
        mode,
        reference.prefix(mode),
      );
      const actual = await a.route(
        point(0),
        point(12),
        mode,
        combined.prefix(mode),
      );
      expect(actual.status).toBe("found");
      expect(expected.status).toBe("found");
      if (actual.status !== "found" || expected.status !== "found")
        throw Error("route missing");
      expect(actual.seconds).toBeCloseTo(expected.seconds!, 5);
      expect(actual.coordinates).toEqual(expected.coordinates);
      expect(actual.wayIds).toEqual(expected.wayIds);
      if (mode === "driving")
        expect(actual.wayIds.some((id) => Number(id.slice(4)) >= 200)).toBe(
          true,
        );
      const expectedArea = await b.isochrone(
        point(6),
        [600, 1200, 1800],
        mode,
        reference.prefix(mode),
      );
      const actualArea = await a.isochrone(
        point(6),
        [600, 1200, 1800],
        mode,
        combined.prefix(mode),
      );
      expect(actualArea.status).toBe("reachable");
      if (
        actualArea.status === "reachable" &&
        expectedArea.status === "reachable"
      )
        expect(actualArea.contours).toEqual(expectedArea.contours);
    }
    expect(new Set([...combined.served.values()].map((v) => v.source))).toEqual(
      new Set(["west", "east"]),
    );
    const reads = west!.reader.requests + east!.reader.requests;
    west!.reader.offline = true;
    east!.reader.offline = true;
    const repeat = await a.route(
      point(0),
      point(12),
      "driving",
      combined.prefix("driving"),
    );
    expect(repeat.status).toBe("found");
    expect(west!.reader.requests + east!.reader.requests).toBe(reads);
  } finally {
    west!.reader.offline = false;
    east!.reader.offline = false;
    a.destroy();
    b.destroy();
  }
}, 30000);
test("matching OSM IDs do not override source revisions; partial source cells are missing, not empty", async () => {
  const west = packages[1]!,
    east = packages[2]!;
  const changed = structuredClone(east.manifest);
  changed.transport!.federation!.sourceRevision = "f".repeat(64);
  const reader = await open(
    await encodePackage(changed, east.inputs, { paged: true }),
  );
  try {
    expect(
      () =>
        new RoutingComposition([
          { id: "w", reader: west.reader },
          { id: "e", reader },
        ]),
    ).toThrow("not compatible");
  } finally {
    reader.dispose();
  }
  const onlyWest = new RoutingComposition([{ id: "w", reader: west.reader }]);
  expect(
    (await onlyWest.read(`routing/driving/cells/14/${cx + 12}/${cy}`)).missing,
  ).toBe(true);
  const partial = {
    ...west.manifest.transport!.federation!,
    completeBounds: [...west.manifest.bounds] as Box,
  };
  partial.completeBounds[0] = point(0)[0];
  expect(ownsRoutingCell(partial, cx, cy)).toBe(false);
});
test("conflicting costs in an overlapping cell are rejected before choosing a host", async () => {
  const west = packages[1]!,
    east = packages[2]!;
  const key = `routing/driving/cells/14/${cx + 6}/${cy}`;
  const inputs = east.inputs.map((b) => ({ ...b, bytes: b.bytes.slice() }));
  const bytes = inputs.find((b) => b.key === key)!.bytes,
    v = new DataView(bytes.buffer);
  const cost = 36 + v.getUint32(20, true) * 24 + 20;
  v.setFloat32(cost, v.getFloat32(cost, true) + 1, true);
  const bad = await open(
    await encodePackage(east.manifest, inputs, { paged: true }),
  );
  try {
    await expect(
      new RoutingComposition([
        { id: "w", reader: west.reader },
        { id: "e", reader: bad },
      ]).read(key),
    ).rejects.toThrow("Conflicting cells");
    const { planAcquisition } = await import(
      "../packages/acquisition/src/plan"
    );
    const plan = await planAcquisition(
      {
        name: "Conflict review",
        polygon: polygon(box(0, 13)),
        families: ["routing:driving"],
        minZoom: 0,
        maxZoom: 0,
        paddingCells: 1,
        sourceIds: ["w", "e"],
      },
      [
        {
          id: "w",
          manifest: west.reader.index.manifest,
          reader: west.reader,
          location: "remote",
          verified: true,
          bytes: 0,
        },
        {
          id: "e",
          manifest: bad.index.manifest,
          reader: bad,
          location: "remote",
          verified: true,
          bytes: 0,
        },
      ],
      new AbortController().signal,
    );
    expect(plan.conflicts).toContain(key);
  } finally {
    bad.dispose();
  }
});
test("non-routing amendments and nested excerpts retain the OSM authority contract", async () => {
  const west = packages[1]!;
  const amended = await open(
    await encodePackage(
      { ...west.manifest, name: "New imagery revision" },
      west.inputs,
      { paged: true },
    ),
  );
  try {
    expect(
      new RoutingComposition([
        { id: "old", reader: west.reader },
        { id: "new", reader: amended },
      ]).compatibility,
    ).toBe("osm-source");
  } finally {
    amended.dispose();
  }
  const target = `${work}/child.atlas`;
  await preparePackage(
    west.reader,
    {
      snapshot: west.reader.index.manifest.snapshot,
      minZoom: 0,
      maxZoom: 0,
      paddingCells: 0,
      name: "Child",
      polygon: polygon(box(-1, 8)),
      layers: [],
      featureKinds: [],
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
      profiles: [...TRANSPORT_MODES],
      maxBytes: 1048576,
    },
    target,
    new AbortController().signal,
    () => {},
  );
  const child = await new AtlasReader(new FileSource(Bun.file(target))).open();
  try {
    expect(child.index.manifest.transport!.federation).toEqual(
      west.manifest.transport!.federation,
    );
    expect(
      new RoutingComposition([
        { id: "child", reader: child },
        { id: "east", reader: packages[2]!.reader },
      ]).compatibility,
    ).toBe("osm-source");
  } finally {
    child.dispose();
  }
});

test("RCL3 identity claims require the codec, supported contract and complete extraction receipts", async () => {
  const { routingAuthority } = await import(
    "../packages/cli/src/routing-authority"
  );
  const west = packages[1]!;
  expect(routingAuthority({})).toBeUndefined();
  expect(
    routingAuthority({
      inputs: west.manifest.source.inputs,
      extraction: {
        bounds: west.manifest.bounds,
        strategy: "complete_ways",
        sourceDate: "test",
      },
    }),
  ).toBeUndefined();
  for (const mutate of [
    (m: any) => {
      delete m.transport.federation;
    },
    (m: any) => {
      m.transport.federation.contract = "other-cost-policy";
    },
    (m: any) => {
      m.transport.profiles.walking.codec = "rcl2";
    },
  ]) {
    const m = structuredClone(west.manifest);
    mutate(m);
    await expect(
      async () =>
        await open(await encodePackage(m, west.inputs, { paged: true })),
    ).toThrow();
  }
  const key = `routing/driving/cells/14/${cx + 6}/${cy}`;
  const bad = west.inputs.map((b) => ({ ...b, bytes: b.bytes.slice() }));
  bad.find((b) => b.key === key)!.bytes.set(new TextEncoder().encode("RCL2"));
  const reader = await open(
    await encodePackage(west.manifest, bad, { paged: true }),
  );
  try {
    await expect(readRoutingCell(reader, key)).rejects.toThrow(
      "identity codec",
    );
  } finally {
    reader.dispose();
  }
});

test("identity retains the original segment index after a repeated-node edge is discarded", () => {
  const ids = new Set<bigint>();
  for (const b of packages[1]!.inputs.filter((b) =>
    b.key.startsWith("routing/walking/"),
  )) {
    const v = new DataView(
        b.bytes.buffer,
        b.bytes.byteOffset,
        b.bytes.byteLength,
      ),
      edges = v.getUint32(24, true);
    for (let p = b.bytes.length - edges * 16; p < b.bytes.length; p += 16) {
      const id = v.getBigUint64(p, true);
      if (id >> 32n === 300n) ids.add(id & 0xffffffffn);
    }
  }
  expect([...ids].sort()).toEqual([1n, 2n]);
});

test("adding a profile uses OSM authority even when compiled package identities differ", async () => {
  const { routingAmendmentSelection } = await import(
    "../packages/provisioning/src/amend"
  );
  const source = structuredClone(packages[1]!.reader.index.manifest),
    target = structuredClone(source);
  target.snapshot = "1".repeat(64);
  target.source.sha256 = "2".repeat(64);
  delete target.transport!.profiles.cycling;
  const request = {
    targetSnapshot: target.snapshot,
    sourceSnapshot: source.snapshot,
    name: "Add cycling",
    profiles: ["cycling"],
    paddingCells: 0,
    maxBytes: 10_000_000,
  };
  expect(routingAmendmentSelection(target, source, request).profiles).toEqual([
    "cycling",
  ]);
  target.transport!.federation!.sourceRevision = "3".repeat(64);
  expect(() => routingAmendmentSelection(target, source, request)).toThrow();
});

test("independent publishers discover and route through Hashtree; a new router replays cached data offline", async () => {
  const { publishedHost, discoverPublishedHost } = await import(
    "./helpers/published-host"
  );
  const { HashtreeSource } = await import("../packages/hashtree/src/source");
  const { verifyPublishedMap } = await import(
    "../packages/hashtree/src/published-map"
  );
  const readers: AtlasReader[] = [],
    routers: PagedRouter[] = [];
  const hosts: Awaited<ReturnType<typeof publishedHost>>[] = [];
  const blobs = new Map<string, Uint8Array>();
  const store = {
    available: true,
    async getIndex() {
      return undefined;
    },
    async putIndex() {},
    async keys() {
      return [];
    },
    async get(s: string, b: { hash: string }) {
      return blobs.get(`${s}:${b.hash}`);
    },
    async put(s: string, b: { hash: string }, v: Uint8Array) {
      blobs.set(`${s}:${b.hash}`, v.slice());
    },
  };
  let offline = false;
  try {
    for (let i = 1; i <= 2; i++) {
      const path = `${work}/published-${i}.atlas`;
      await Bun.write(path, packages[i]!.bytes);
      hosts.push(await publishedHost(path, `${work}/publisher-${i}`));
    }
    expect(hosts[0]!.pubkey).not.toBe(hosts[1]!.pubkey);
    const offers = await Promise.all(hosts.map(discoverPublishedHost));
    expect(offers[0]!.hashtree!.root).not.toBe(offers[1]!.hashtree!.root);
    async function openOffers() {
      return Promise.all(
        offers.map(async (offer) => {
          const reader = await new AtlasReader(
            new HashtreeSource(offer.url, offer.hashtree!, offer.api, {
              store,
              offline: () => offline,
            }),
            undefined,
            { store },
          ).open();
          verifyPublishedMap(offer, reader);
          reader.offline = offline;
          readers.push(reader);
          return { id: offer.url, reader };
        }),
      );
    }
    const combined = new RoutingComposition(await openOffers()),
      a = router(combined);
    const b = router(
      new RoutingComposition([{ id: "ref", reader: packages[0]!.reader }]),
    );
    routers.push(a, b);
    blobs.clear();
    readers.forEach((r) =>
      (r.source as InstanceType<typeof HashtreeSource>).clear(),
    );
    hosts[1]!.unavailable();
    expect(
      (
        await a.route(
          point(0),
          point(12),
          "driving",
          combined.prefix("driving"),
        )
      ).status,
    ).toBe("missing-data");
    hosts[1]!.unavailable(false);
    for (const mode of TRANSPORT_MODES) {
      const expected = await b.route(
        point(0),
        point(12),
        mode,
        combined.prefix(mode),
      );
      const actual = await a.route(
        point(0),
        point(12),
        mode,
        combined.prefix(mode),
      );
      expect(actual.status).toBe("found");
      if (actual.status !== "found" || expected.status !== "found")
        throw Error("Route missing");
      expect(actual.coordinates).toEqual(expected.coordinates);
      expect(actual.seconds).toEqual(expected.seconds);
      expect(actual.wayIds).toEqual(expected.wayIds);
    }
    expect(
      new Set([...combined.served.values()].map((v) => v.source)).size,
    ).toBe(2);
    for (const h of hosts) {
      expect(h.stats().blobRequests).toBeGreaterThan(0);
      expect(h.stats().rawRequests).toBe(0);
    }
    const reads = hosts.map((h) => h.stats().blobRequests);
    offline = true;
    await Promise.all(hosts.map((h) => h.close()));
    // Drop all readers/engines: this proves persisted content-addressed bytes, not a warm graph.
    readers.forEach((r) => r.dispose());
    routers.forEach((r) => r.destroy());
    readers.length = 0;
    routers.length = 0;
    const fresh = new RoutingComposition(await openOffers()),
      c = router(fresh);
    routers.push(c);
    expect(
      (await c.route(point(0), point(12), "driving", fresh.prefix("driving")))
        .status,
    ).toBe("found");
    expect(hosts.map((h) => h.stats().blobRequests)).toEqual(reads);
    // Correctly signed but inaccurate metadata must not override the root-pinned file.
    const claim = structuredClone(offers[0]!);
    claim.manifest.transport!.federation!.sourceRevision = "a".repeat(64);
    expect(() => verifyPublishedMap(claim, readers[0]!)).toThrow(
      "Published transport differs",
    );
  } finally {
    routers.forEach((r) => r.destroy());
    readers.forEach((r) => r.dispose());
    await Promise.all(hosts.map((h) => h.close()));
  }
}, 30000);

test("area acquisition from independent Hashtree publishers survives interruption and routes offline from one portable file", async () => {
  const { Acquisitions } = await import("../apps/server/acquisitions");
  const { publishedHost } = await import("./helpers/published-host");
  const { openMembers } = await import("../packages/format/src/composition");
  const { AtlasGeocoder } = await import("../packages/geocoding/src/index");
  const { randomBytes } = await import("node:crypto");
  const hosts: Awaited<ReturnType<typeof publishedHost>>[] = [];
  let manager: Awaited<ReturnType<typeof Acquisitions.open>> | undefined;
  const opened: AtlasReader[] = [];
  const folder = `${work}/area-rehearsal`;
  const wait = async () => {
    const end = Date.now() + 20000;
    while (
      manager!
        .view()
        .some((j) => ["planning", "fetching", "packing"].includes(j.state))
    ) {
      if (Date.now() > end) throw Error(JSON.stringify(manager!.view()));
      await Bun.sleep(5);
    }
    await Bun.sleep(10);
  };
  try {
    for (const [i, p] of packages.slice(1).entries()) {
      const bytes = await encodePackage(
        {
          ...p.manifest,
          capabilities: [
            "transport-routing",
            "location-search",
            "address-search",
          ],
          semantics: {
            version: 1,
            addresses: "osm-explicit",
            poiTags: true,
            administrativeHierarchy: false,
          },
        },
        [
          {
            key: "custom/not-requested-before",
            bytes: randomBytes(256 * 1024),
          },
          ...p.inputs,
          {
            key: "custom/not-requested-middle",
            bytes: randomBytes(256 * 1024),
          },
          {
            key: "search/locations",
            bytes: new TextEncoder().encode(
              JSON.stringify({
                schema: "locations-v1",
                records: [
                  {
                    id: `node/${900 + i}`,
                    name: i ? "East Street 12" : "West Street 1",
                    aliases: [],
                    kind: "address",
                    category: "address",
                    coordinates: point(i ? 12 : 0),
                    address: {
                      source: "osm-explicit",
                      street: i ? "East Street" : "West Street",
                      houseNumber: i ? "12" : "1",
                    },
                  },
                ],
              }),
            ),
          },
          { key: "custom/not-requested-after", bytes: randomBytes(256 * 1024) },
        ],
        { paged: true },
      );
      const path = `${folder}/publisher-${i}.atlas`;
      await Bun.write(path, bytes);
      hosts.push(await publishedHost(path, `${folder}/publisher-${i}`));
    }
    manager = await Acquisitions.open(`${folder}/jobs`, async () => {});
    const b = box(0, 13); // keep requested cells strictly inside each authority's bounds
    const id = await manager.create(
      {
        name: "Independent offline journey",
        polygon: polygon(b),
        families: [
          "routing:walking",
          "routing:cycling",
          "routing:driving",
          "addresses",
        ],
        minZoom: 0,
        maxZoom: 0,
        paddingCells: 1,
        sourceIds: ["west", "east"],
      },
      hosts.map((h, i) => ({
        id: i ? "east" : "west",
        manifest: h.offer.manifest,
        offer: h.offer,
        location: "remote",
        verified: true,
        root: h.offer.hashtree!.root,
        bytes: h.offer.bytes,
      })),
    );
    await wait();
    const plan = manager.view()[0]!;
    expect(plan.error).toBeUndefined();
    expect(plan.state).toBe("review");
    expect(plan.plan!.members).toBe(2);
    expect(plan.plan!.conflicts).toEqual([]);
    // Network loss after planning retains pinned metadata and acquired blocks.
    hosts.forEach((h) => h.unavailable());
    await manager.resume(id, false, true);
    await wait();
    expect(manager.view()[0]!.state).toBe("failed");
    await manager.close();
    manager = await Acquisitions.open(`${folder}/jobs`, async () => {});
    hosts.forEach((h) => h.unavailable(false));
    await manager.resume(id, false, true);
    await wait();
    expect(manager.view()[0]!.error).toBeUndefined();
    expect(manager.view()[0]!.state).toBe("ready");
    expect(manager.view()[0]!.reusedBytes).toBeGreaterThan(0);
    hosts.forEach((h) => h.unavailable());
    const parent = await new AtlasReader(
      new FileSource(manager.file(id)),
    ).open();
    opened.push(parent);
    const members = await openMembers(parent);
    opened.push(...members.map((m) => m.reader));
    expect(members.length).toBe(2);
    const combined = new RoutingComposition(
        members.map((m) => ({ id: m.id, reader: m.reader })),
      ),
      engine = router(combined);
    const reference = new RoutingComposition([
        { id: "whole", reader: packages[0]!.reader },
      ]),
      expectedEngine = router(reference);
    try {
      for (const mode of TRANSPORT_MODES) {
        const expected = await expectedEngine.route(
          point(0),
          point(12),
          mode,
          reference.prefix(mode),
        );
        const result = await engine.route(
          point(0),
          point(12),
          mode,
          combined.prefix(mode),
        );
        expect(result.status).toBe("found");
        expect(expected.status).toBe("found");
        if (result.status === "found" && expected.status === "found")
          expect(result.seconds).toBeCloseTo(expected.seconds!, 5);
      }
      const hits = [];
      for (const m of members)
        hits.push(
          ...(await new AtlasGeocoder(m.reader).search("East Street 12"))
            .matches,
        );
      expect(hits.some((h) => h.id === "node/901")).toBe(true);
    } finally {
      engine.destroy();
      expectedEngine.destroy();
    }
    expect(hosts.every((h) => h.stats().rawRequests === 0)).toBe(true);
    for (const m of members)
      for await (const b of m.reader.iterateBlocks())
        expect(b.key.startsWith("custom/")).toBe(false);
  } finally {
    await manager?.close();
    opened.forEach((r) => r.dispose());
    for (const h of hosts) await h.close();
  }
}, 60000);
