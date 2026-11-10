import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { parseCatalog, type MapOffer } from "../packages/format/src/catalog";
import { mapReference } from "../packages/format/src/urls";
import { buildTreeIndex, IndexedTree } from "../packages/hashtree/src/build";
import {
  HashtreeSource,
  parseTree,
  parseFipsProviders,
  type FipsProvider,
  type TreeOffer,
} from "../packages/hashtree/src/source";
import {
  mapAnnouncement,
  parseAnnouncement,
  publishAnnouncement,
  watchMaps,
} from "../packages/hashtree/src/discovery";
import {
  defaultPresentation,
  parseViewRecipe,
} from "../packages/views/src/index";
import {
  viewAnnouncement,
  parseViewAnnouncement,
} from "../packages/views/src/announcement";
import { localRelay } from "./helpers/nostr-relay";
import { workspaceFixture } from "./helpers/workspace-fixture";

const root = "a".repeat(64);
const provider: FipsProvider = {
  peerId: "02" + "b".repeat(64),
  seedUrls: ["wss://seed.example/fips"],
};
function tree(): TreeOffer {
  return {
    version: 1,
    root,
    bytes: 100,
    chunkBytes: 65536,
    providers: [],
    fips: [provider],
  };
}

test("FIPS offers validate compressed identities, seed URLs and service ports", () => {
  expect(parseTree(tree(), 100).fips).toEqual([
    { ...provider, servicePort: 39018 },
  ]);
  expect(
    parseFipsProviders([{ ...provider, servicePort: 5000, rpcPort: 39019 }])[0]
      ?.rpcPort,
  ).toBe(39019);
  for (const bad of [
    { ...provider, peerId: "b".repeat(64) },
    { ...provider, peerId: "04" + "b".repeat(64) },
    { ...provider, seedUrls: [] },
    { ...provider, seedUrls: ["https://seed.example"] },
    { ...provider, seedUrls: ["wss://name:password@seed.example"] },
    { ...provider, seedUrls: ["wss://seed.example/#secret"] },
    { ...provider, servicePort: 0 },
    { ...provider, servicePort: 65536 },
    { ...provider, rpcPort: 1.5 },
  ])
    expect(() => parseTree({ ...tree(), fips: [bad] }, 100)).toThrow();
  expect(() => parseTree({ ...tree(), fips: [] }, 100)).toThrow(
    "Invalid Hashtree offer",
  );
  expect(() => parseTree({ ...tree(), fips: undefined }, 100)).toThrow(
    "Invalid Hashtree offer",
  );
  expect(
    parseFipsProviders([
      provider,
      { ...provider, seedUrls: ["wss://second.example/fips"] },
    ]),
  ).toHaveLength(1);
});

test("content-addressed catalogs and signed views need no HTTP host and bind identity to the root", async () => {
  const data = await workspaceFixture();
  try {
    const offer: MapOffer = {
      id: "map",
      url: `htree://${root}`,
      bytes: 100,
      manifest: data.reader.index.manifest,
      hashtree: tree(),
    };
    const parsed = parseCatalog(
      { maps: [offer] },
      "https://unused.example",
    )[0]!;
    expect(parsed.url).toBe(`htree://${root}`);
    expect(parsed.api).toBeUndefined();
    expect(parsed.hashtree?.providers).toEqual([]);
    const key = generateSecretKey();
    const event = mapAnnouncement(parsed, key);
    expect(parseAnnouncement(event).offer).toEqual(parsed);
    // Mutation after nostr-tools has cached successful verification must still fail.
    event.content = event.content.replace("Task demo", "Tampered");
    expect(() => parseAnnouncement(event)).toThrow("signed");
    expect(() =>
      parseCatalog(
        { maps: [{ ...offer, url: `htree://${"c".repeat(64)}` }] },
        "https://unused.example",
      ),
    ).toThrow("disagree");
    expect(() =>
      parseCatalog(
        { maps: [{ ...offer, hashtree: undefined }] },
        "https://unused.example",
      ),
    ).toThrow("require a Hashtree");
    const view = parseViewRecipe({
      version: 1,
      id: "coasts",
      name: "Coasts",
      coverage: true,
      sources: [
        {
          url: offer.url,
          root,
          enabled: true,
          layers: ["water"],
          labels: false,
        },
      ],
      presentation: defaultPresentation(),
    });
    expect(
      parseViewAnnouncement(viewAnnouncement(view, key)).recipe.sources[0]?.url,
    ).toBe(offer.url);
    expect(() =>
      parseViewRecipe({
        ...view,
        sources: [{ ...view.sources[0], root: "c".repeat(64) }],
      }),
    ).toThrow("disagree");
    for (const suffix of ["/", "?host=x", "#x", "/map"])
      expect(() => mapReference(offer.url + suffix)).toThrow();
    expect(() => mapReference("file:///tmp/map.atlas")).toThrow();
    expect(
      parseCatalog(
        { maps: [{ ...offer, url: "/map.atlas", api: "/api" }] },
        "https://legacy.example",
      )[0]?.api,
    ).toBe("https://legacy.example/api");
  } finally {
    data.reader.dispose();
  }
});

async function indexedFixture() {
  const dir = await mkdtemp("/tmp/atlas-fips-contract-");
  const bytes = randomBytes(200000);
  await Bun.write(`${dir}/map.atlas`, bytes);
  const info = await buildTreeIndex(`${dir}/map.atlas`, `${dir}/index`);
  const index = IndexedTree.open(`${dir}/index`);
  const offer: TreeOffer = { ...tree(), root: info.root, bytes: bytes.length };
  return {
    bytes,
    index,
    offer,
    async close() {
      index.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("advertised FIPS is preferred; failure never silently falls back to HTTP", async () => {
  const f = await indexedFixture();
  const http = spyOn(globalThis, "fetch").mockRejectedValue(
    Error("HTTP must stay unused"),
  );
  const offer = { ...f.offer, providers: ["https://unused.example/blobs"] };
  try {
    let reads = 0;
    const source = new HashtreeSource(
      `htree://${offer.root}`,
      offer,
      undefined,
      {
        fetchFipsBlob: async (hash, providers, signal) => {
          expect(providers[0]?.peerId).toBe(provider.peerId);
          signal.throwIfAborted();
          reads++;
          return f.index.get(hash);
        },
      },
    );
    expect(await source.read(65530, 65560)).toEqual(
      new Uint8Array(f.bytes.slice(65530, 65560)),
    );
    expect(reads).toBe(3);
    await source.read(65530, 65560);
    expect(reads).toBe(3);
    expect(
      () => new HashtreeSource(`htree://${"c".repeat(64)}`, offer),
    ).toThrow("disagree");
    const disconnected = new HashtreeSource(`htree://${offer.root}`, offer);
    await expect(disconnected.read(0, 1)).rejects.toThrow(
      "FIPS transport is unavailable",
    );
    const corrupt = new HashtreeSource(
      `htree://${offer.root}`,
      offer,
      undefined,
      {
        fetchFipsBlob: async () => new Uint8Array([1, 2, 3]),
      },
    );
    await expect(corrupt.read(0, 1)).rejects.toThrow("Blob hash mismatch");
    expect(http).not.toHaveBeenCalled();
  } finally {
    http.mockRestore();
    await f.close();
  }
});

test("HTTP use requires explicit selection or fallback when FIPS is advertised", async () => {
  const f = await indexedFixture();
  let httpReads = 0,
    fipsReads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      httpReads++;
      const bytes = await f.index.get(new URL(req.url).pathname.slice(1));
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: 404 });
    },
  });
  const offer = { ...f.offer, providers: [server.url.href.slice(0, -1)] };
  try {
    const options = {
      fetchFipsBlob: async () => {
        fipsReads++;
        throw Error("Peer unavailable");
      },
    };
    const fallback = new HashtreeSource(
      `htree://${offer.root}`,
      offer,
      undefined,
      { ...options, allowHttpFallback: true },
    );
    expect(await fallback.read(0, 1)).toEqual(
      new Uint8Array(f.bytes.slice(0, 1)),
    );
    expect(httpReads).toBe(2);
    expect(fipsReads).toBe(2);
    const explicit = new HashtreeSource(
      `htree://${offer.root}`,
      offer,
      undefined,
      { ...options, transport: "http" },
    );
    await explicit.read(0, 1);
    expect(httpReads).toBe(4);
    expect(fipsReads).toBe(2);
    const exclusive = new HashtreeSource(
      `htree://${offer.root}`,
      offer,
      undefined,
      { fetchBlob: async () => null, allowHttpFallback: true },
    );
    await expect(exclusive.read(0, 1)).rejects.toThrow("Blob unavailable");
    expect(httpReads).toBe(4);
  } finally {
    server.stop(true);
    await f.close();
  }
});

test("signed withdrawals remove old offers, reject stale replay, and allow newer publications", async () => {
  const data = await workspaceFixture(),
    relay = localRelay(),
    abort = new AbortController();
  const key = generateSecretKey(),
    now = Math.floor(Date.now() / 1000);
  const offer: MapOffer = {
    id: "map",
    url: `htree://${root}`,
    bytes: 100,
    manifest: data.reader.index.manifest,
    hashtree: tree(),
  };
  const original = mapAnnouncement(offer, key, now - 30);
  const withdrawal = finalizeEvent(
    {
      kind: 5,
      created_at: now - 20,
      content: "Unpublished",
      tags: [
        ["e", original.id],
        ["a", `30064:${original.pubkey}:atlas/map`],
      ],
    },
    key,
  );
  const stale = mapAnnouncement(offer, key, now - 25);
  const renewed = mapAnnouncement(offer, key, now - 10);
  const attackerKey = generateSecretKey();
  const attacker = finalizeEvent(
    {
      kind: 5,
      created_at: now,
      content: "",
      tags: [
        ["e", renewed.id],
        ["a", `30064:${original.pubkey}:atlas/map`],
      ],
    },
    attackerKey,
  );
  const seen: string[] = [],
    removed: string[] = [];
  const ready = Promise.withResolvers<void>();
  let stop: (() => void) | undefined;
  try {
    for (const event of [original, withdrawal, stale, renewed, attacker])
      await publishAnnouncement(relay.url, event);
    stop = await watchMaps(
      relay.url,
      [original.pubkey, attacker.pubkey],
      (_offer, e) => seen.push(e.id),
      abort.signal,
      () => {},
      undefined,
      {
        ready: ready.resolve,
        withdrawn: (id, publisher) => removed.push(`${publisher}:${id}`),
      },
    );
    await ready.promise;
    expect(seen).toEqual([original.id, renewed.id]);
    expect(removed).toEqual([`${original.pubkey}:map`]);
  } finally {
    stop?.();
    abort.abort();
    relay.close();
    data.reader.dispose();
  }
});

test("event-specific deletion does not suppress another revision of the same map", async () => {
  const data = await workspaceFixture(),
    relay = localRelay(),
    abort = new AbortController();
  const key = generateSecretKey(),
    now = Math.floor(Date.now() / 1000);
  const offer: MapOffer = {
    id: "map",
    url: `htree://${root}`,
    bytes: 100,
    manifest: data.reader.index.manifest,
    hashtree: tree(),
  };
  const original = mapAnnouncement(offer, key, now - 30);
  const renewal = mapAnnouncement(offer, key, now - 20);
  const deletion = finalizeEvent(
    { kind: 5, created_at: now - 10, content: "", tags: [["e", original.id]] },
    key,
  );
  const seen: string[] = [],
    ready = Promise.withResolvers<void>();
  let stop: (() => void) | undefined;
  try {
    for (const event of [original, deletion, renewal])
      await publishAnnouncement(relay.url, event);
    stop = await watchMaps(
      relay.url,
      [original.pubkey],
      (_offer, e) => seen.push(e.id),
      abort.signal,
      () => {},
      undefined,
      { ready: ready.resolve },
    );
    await ready.promise;
    expect(seen).toEqual([original.id, renewal.id]);
  } finally {
    stop?.();
    abort.abort();
    relay.close();
    data.reader.dispose();
  }
});

test("relay publication times out when a relay accepts a connection but never acknowledges", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message() {} },
  });
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: "local test",
      tags: [],
    },
    generateSecretKey(),
  );
  try {
    await expect(
      publishAnnouncement(`ws://127.0.0.1:${server.port}`, event, 30),
    ).rejects.toThrow();
  } finally {
    server.stop(true);
  }
}, 1000);
