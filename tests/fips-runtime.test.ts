import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "@fips/core";
import { sha256 } from "../packages/format/src/index";
import { startFipsServer, discardStore } from "../packages/fips/src/server";
import { FipsClient } from "../packages/fips/src/client";
import { validateRpcRequest } from "../packages/fips/src/rpc";
import { HashtreeSource } from "../packages/hashtree/src/source";
import { AtlasReader } from "../packages/format/src/reader";
import { buildTreeIndex, IndexedTree } from "../packages/hashtree/src/build";
import { workspaceFixture } from "./helpers/workspace-fixture";
import {
  mapAnnouncement,
  parseAnnouncement,
} from "../packages/hashtree/src/discovery";
import { generateSecretKey } from "nostr-tools/pure";

class MemoryCarrier implements Transport {
  readonly type = "memory";
  readonly mtu = 65535;
  readonly maxFrameBytes = 66000;
  context?: TransportContext;
  identity = "";
  constructor(private peers: Map<string, MemoryCarrier>) {}
  async start(context: TransportContext) {
    this.context = context;
    this.identity = toHex(context.localIdentity.publicKey);
    this.peers.set(this.identity, this);
  }
  async stop() {
    this.peers.delete(this.identity);
    this.context = undefined;
  }
  async connect(address: TransportAddress) {
    if (!this.peers.has(address.addr)) throw new Error("Peer unavailable");
  }
  async send(address: TransportAddress, packet: Uint8Array) {
    const target = this.peers.get(address.addr);
    if (!target?.context) throw new Error("Peer stopped");
    const copy = packet.slice();
    queueMicrotask(() =>
      target.context?.onPacket({
        transportType: this.type,
        remoteAddr: { transport: this.type, addr: this.identity },
        data: copy,
        receivedAtMs: Date.now(),
      }),
    );
  }
}
test("two signed maps open, selectively read and cache through real FIPS stacks with no HTTP map origin", async () => {
  const directory = await mkdtemp("/tmp/atlas-fips-maps-");
  const a = await workspaceFixture([16, 48, 16.012, 48.02]),
    b = await workspaceFixture([16.008, 48, 16.02, 48.02]);
  const indexes: IndexedTree[] = [];
  const peers = new Map<string, MemoryCarrier>();
  let blobReads = 0;
  let server: Awaited<ReturnType<typeof startFipsServer>> | undefined,
    client: FipsClient | undefined;
  const readers: AtlasReader[] = [];
  try {
    for (const [i, data] of [a, b].entries()) {
      await Bun.write(`${directory}/${i}.atlas`, data.bytes);
      await buildTreeIndex(
        `${directory}/${i}.atlas`,
        `${directory}/${i}.sqlite`,
      );
      indexes.push(IndexedTree.open(`${directory}/${i}.sqlite`));
    }
    server = await startFipsServer({
      keyPath: `${directory}/key`,
      seedUrls: [],
      transports: [new MemoryCarrier(peers)],
      getBlob: async (hash) => {
        blobReads++;
        for (const index of indexes) {
          const bytes = await index.get(hash);
          if (bytes) return bytes;
        }
        return null;
      },
    });
    client = new FipsClient({
      transports: () => [new MemoryCarrier(peers)],
      bootstrap: [{ transport: "memory", addr: server.peerId }],
      timeoutMs: 3000,
    });
    const publisher = generateSecretKey();
    for (const [i, data] of [a, b].entries()) {
      const info = indexes[i]!.info;
      const offer = parseAnnouncement(
        mapAnnouncement(
          {
            id: String(i),
            url: `htree://${info.root}`,
            bytes: info.bytes,
            manifest: data.reader.index.manifest,
            hashtree: {
              version: 1,
              root: info.root,
              bytes: info.bytes,
              chunkBytes: info.chunkBytes,
              providers: [],
              fips: [
                {
                  peerId: server.peerId,
                  seedUrls: ["wss://fixture.invalid/fips"],
                  servicePort: 39018,
                },
              ],
            },
          },
          publisher,
        ),
      ).offer;
      let offline = false;
      const source = new HashtreeSource(offer.url, offer.hashtree!, undefined, {
        offline: () => offline,
        fetchFipsBlob: (hash, providers, signal) =>
          client!.fetchBlob(hash, providers, signal),
        requestTimeoutMs: 10000,
      });
      const reader = await new AtlasReader(source, undefined, {
        purposes: ["map", "labels"],
      }).open();
      readers.push(reader);
      expect(reader.index.manifest.snapshot).toBe(
        data.reader.index.manifest.snapshot,
      );
      expect(reader.bytesByPurpose.routing).toBe(0);
      expect(reader.bytesByPurpose.search).toBe(0);
      const before = blobReads;
      offline = true;
      await source.read(0, 32);
      expect(blobReads).toBe(before);
    }
    expect(readers.length).toBe(2);
    expect(client.status().bytesReceived).toBeGreaterThan(0);
  } finally {
    readers.forEach((r) => r.dispose());
    a.reader.dispose();
    b.reader.dispose();
    await client?.stop();
    await server?.stop();
    indexes.forEach((i) => i.close());
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("FIPS provider failover, deduplication, missing reads and JSON/binary operation responses", async () => {
  const directory = await mkdtemp("/tmp/atlas-fips-rpc-"),
    peers = new Map<string, MemoryCarrier>();
  const bytes = new TextEncoder().encode("verified map payload"),
    hash = await sha256(bytes);
  let reads = 0;
  const root = "a".repeat(64);
  const server = await startFipsServer({
    keyPath: `${directory}/key`,
    seedUrls: [],
    transports: [new MemoryCarrier(peers)],
    getBlob: async (h) => {
      reads++;
      return h === hash ? bytes : null;
    },
    rpc: async (request, peer) => ({
      status: 200,
      headers: { "X-Atlas-Snapshot": root },
      ...(request.path === "offline"
        ? { bytes: new Uint8Array([0, 255, 128, 13, 10]) }
        : { body: { root: request.root, peer, input: request.body } }),
    }),
  });
  const missing = await startFipsServer({
    keyPath: `${directory}/missing-key`,
    seedUrls: [],
    transports: [new MemoryCarrier(peers)],
    getBlob: async () => null,
  });
  const client = new FipsClient({
    transports: () => [new MemoryCarrier(peers)],
    bootstrap: [
      { transport: "memory", addr: server.peerId },
      { transport: "memory", addr: missing.peerId },
    ],
    timeoutMs: 3000,
  });
  const good = {
    peerId: server.peerId,
    seedUrls: ["wss://fixture.invalid/fips"],
    rpcPort: 39019,
  };
  try {
    const providers = [{ ...good, peerId: missing.peerId }, good];
    const [x, y] = await Promise.all([
      client.fetchBlob(hash, providers),
      client.fetchBlob(hash, providers),
    ]);
    expect(x).toEqual(bytes);
    expect(y).toEqual(bytes);
    expect(reads).toBe(1);
    expect(await client.fetchBlob("f".repeat(64), [good])).toBeNull();
    const response = await client.request(good, {
      root,
      path: "/search",
      method: "POST",
      body: { query: "Vienna" },
    });
    expect(response.status).toBe(200);
    expect(response.headers?.["X-Atlas-Snapshot"]).toBe(root);
    expect((response.body as any).input).toEqual({ query: "Vienna" });
    expect((response.body as any).peer).toMatch(/^(02|03)[a-f0-9]{64}$/);
    const binary = await client.request(good, {
      root,
      path: "offline",
      method: "POST",
    });
    expect(binary.bytes).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
    const aborted = new AbortController();
    aborted.abort(new Error("Cancelled"));
    await expect(
      client.fetchBlob(hash, [good], aborted.signal),
    ).rejects.toThrow("Cancelled");
  } finally {
    await client.stop();
    await server.stop();
    await missing.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("FIPS operation routing rejects paths outside a pinned map operation", () => {
  for (const path of [
    "../admin",
    "/admin/operations",
    "https://host/api/search",
    "search?secret=x",
    "members/../search",
  ])
    expect(() =>
      validateRpcRequest({ root: "a".repeat(64), path, method: "GET" }),
    ).toThrow();
  expect(() =>
    validateRpcRequest({ root: "latest", path: "search", method: "GET" }),
  ).toThrow();
  expect(
    validateRpcRequest({
      root: "a".repeat(64),
      path: "/members/m0/capabilities",
      method: "GET",
    }).path,
  ).toBe("members/m0/capabilities");
});

test("FIPS invokes the same operation registry, including custom code, host revocation and snapshot pins", async () => {
  const { pluginFixture, polygon } = await import("./helpers/plugin-fixture");
  const { createApiHandler } = await import("../apps/server/api");
  const { RemoteOperations } = await import("../packages/operations/src/index");
  const { fipsOperationRequest } = await import("../apps/web/src/transport");
  const f = await pluginFixture(),
    api = createApiHandler(f.engine);
  const directory = await mkdtemp("/tmp/atlas-fips-registry-");
  const peers = new Map<string, MemoryCarrier>();
  const root = await sha256(f.bytes);
  const server = await startFipsServer({
    keyPath: `${directory}/key`,
    seedUrls: [],
    transports: [new MemoryCarrier(peers)],
    getBlob: async () => null,
    rpc: async (request, _peer, signal) => {
      if (request.root !== root)
        return { status: 404, body: { error: "Unknown root" } };
      const response = await api(
        new Request(`http://internal.invalid/api/${request.path}`, {
          method: request.method,
          signal,
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
        }),
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json(),
      };
    },
  });
  const client = new FipsClient({
    transports: () => [new MemoryCarrier(peers)],
    bootstrap: [{ transport: "memory", addr: server.peerId }],
  });
  const tree = {
    version: 1 as const,
    root,
    bytes: f.bytes.length,
    chunkBytes: 65536,
    providers: [],
    fips: [
      {
        peerId: server.peerId,
        seedUrls: ["wss://fixture.invalid/fips"],
        rpcPort: 39019,
      },
    ],
  };
  const request = fipsOperationRequest(tree, (...args) =>
    client.request(...args),
  );
  const remote = new RemoteOperations(
    `htree://${root}`,
    f.reader.index.manifest.snapshot,
    request,
  );
  try {
    const local = await f.engine.query({
      kind: "water",
      bounds: [9, 47, 9.2, 47.2],
    });
    const result = await remote.call("features", {
      kind: "water",
      bounds: [9, 47, 9.2, 47.2],
    });
    expect(result.result.matched).toBe(local.matched);
    expect(result.execution.side).toBe("server");
    const custom = await request(f.ref.id, {
      method: "POST",
      body: JSON.stringify({
        ...f.ref,
        snapshot: f.reader.index.manifest.snapshot,
        input: { polygon },
      }),
    });
    expect(custom.status).toBe(200);
    expect((await custom.json()).result).toEqual(
      await f.engine.registry.invoke(f.ref, { polygon }),
    );
    const stale = new RemoteOperations(
      `htree://${root}`,
      "0".repeat(64),
      request,
    );
    await expect(
      stale.call("features", { kind: "water", bounds: [9, 47, 9.2, 47.2] }),
    ).rejects.toThrow("snapshot");
    f.engine.registry.setEnabled("features", false);
    await expect(
      remote.call("features", { kind: "water", bounds: [9, 47, 9.2, 47.2] }),
    ).rejects.toThrow("disabled");
  } finally {
    await client.stop();
    await server.stop();
    f.engine.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("abandoned FIPS reads leave the queue while remaining shared callers and new tiles complete", async () => {
  const directory = await mkdtemp("/tmp/atlas-fips-cancel-"),
    peers = new Map<string, MemoryCarrier>();
  const payloads = [
    "shared tile",
    "abandoned active tile",
    "current viewport tile",
  ].map((value) => new TextEncoder().encode(value));
  const hashes = await Promise.all(payloads.map(sha256));
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const requested: string[] = [];
  const server = await startFipsServer({
    keyPath: `${directory}/key`,
    seedUrls: [],
    transports: [new MemoryCarrier(peers)],
    getBlob: async (hash) => {
      requested.push(hash);
      if (requested.length === 2) entered.resolve();
      await release.promise;
      return payloads[hashes.indexOf(hash)] ?? null;
    },
  });
  const client = new FipsClient({
    transports: () => [new MemoryCarrier(peers)],
    bootstrap: [{ transport: "memory", addr: server.peerId }],
    timeoutMs: 3000,
  });
  const providers = [
    { peerId: server.peerId, seedUrls: ["wss://fixture.invalid/fips"] },
  ];
  try {
    const firstAbort = new AbortController(),
      activeAbort = new AbortController();
    const first = client
      .fetchBlob(hashes[0]!, providers, firstAbort.signal)
      .catch(() => "cancelled");
    const shared = client.fetchBlob(hashes[0]!, providers);
    const active = client
      .fetchBlob(hashes[1]!, providers, activeAbort.signal)
      .catch(() => "cancelled");
    await entered.promise;
    const queued = Array.from({ length: 128 }, (_, i) => {
      const abort = new AbortController();
      const promise = client
        .fetchBlob(i.toString(16).padStart(64, "0"), providers, abort.signal)
        .catch(() => "cancelled");
      return { abort, promise };
    });
    expect(client.status().queuedTransfers).toBe(128);
    firstAbort.abort();
    activeAbort.abort();
    queued.forEach((job) => job.abort.abort());
    expect(await first).toBe("cancelled");
    expect(await active).toBe("cancelled");
    expect(await Promise.all(queued.map((job) => job.promise))).toEqual(
      Array(128).fill("cancelled"),
    );
    expect(client.status().queuedTransfers).toBe(0);
    // The active TCP streams retain their two slots until they settle; cancellation
    // of one shared caller must not disconnect the other caller.
    expect(client.status().activeTransfers).toBe(2);
    const visible = client.fetchBlob(hashes[2]!, providers);
    expect(client.status().queuedTransfers).toBe(1);
    release.resolve();
    expect(await shared).toEqual(payloads[0]);
    expect(await visible).toEqual(payloads[2]);
    expect(requested.sort()).toEqual([...hashes].sort());
    expect(client.status().queuedTransfers).toBe(0);
    expect(client.status().retries).toBe(0);
    expect(await client.fetchBlob(hashes[1]!, providers)).toEqual(payloads[1]);
  } finally {
    release.resolve();
    await client.stop();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("transient blob polling failures do not escape the timer or stop later polls", async () => {
  const { TcpBlobTransport } = await import(
    "../packages/fips/src/vendor/tcpBlobTransport"
  );
  const { FipsNode, generateIdentity } = await import("@fips/core");
  const node = new FipsNode({
    identity: await generateIdentity(),
    transports: [new MemoryCarrier(new Map())],
  });
  await node.start();
  const transport = new TcpBlobTransport({
    endpoint: node,
    localStore: discardStore,
  });
  const internal = transport as unknown as {
    tcp: { poll: () => Promise<void> };
  };
  const poll = internal.tcp.poll.bind(internal.tcp);
  let count = 0;
  let resolve!: () => void;
  const recovered = new Promise<void>((done) => {
    resolve = done;
  });
  internal.tcp.poll = async () => {
    if (++count === 1) throw new Error("temporary carrier send failure");
    await poll();
    resolve();
  };
  try {
    await recovered;
    expect(count).toBeGreaterThanOrEqual(2);
  } finally {
    internal.tcp.poll = poll;
    await transport.close();
    await node.stop();
  }
});
