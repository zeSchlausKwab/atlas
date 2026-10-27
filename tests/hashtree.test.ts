import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { HashTree, fromHex, toHex, type Store } from "@hashtree/core";
import { generateSecretKey } from "nostr-tools/pure";
import { buildTreeIndex, IndexedTree } from "../packages/hashtree/src/build";
import {
  HashtreeSource,
  type TreeOffer,
} from "../packages/hashtree/src/source";
import {
  mapAnnouncement,
  parseAnnouncement,
  watchMaps,
  publishAnnouncement,
} from "../packages/hashtree/src/discovery";
import { localRelay } from "./helpers/nostr-relay";
import { workspaceFixture } from "./helpers/workspace-fixture";
import { AtlasReader } from "../packages/format/src/reader";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { MapDiscovery } from "../apps/server/discovery";
import type { MapOffer } from "../packages/format/src/catalog";
async function fixture(bytes: Uint8Array) {
  const dir = await mkdtemp("/tmp/atlas-hashtree-");
  const path = `${dir}/map.atlas`;
  await Bun.write(path, bytes);
  const meta = await buildTreeIndex(path, `${dir}/index`);
  const index = IndexedTree.open(`${dir}/index`);
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const bytes = await index.get(new URL(req.url).pathname.slice(1));
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: 404 });
    },
  });
  const tree: TreeOffer = {
    version: 1,
    root: meta.root,
    bytes: meta.bytes,
    chunkBytes: meta.chunkBytes,
    providers: [host.url.href.slice(0, -1)],
  };
  return {
    dir,
    path,
    index,
    host,
    tree,
    close: async () => {
      host.stop(true);
      index.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("nested public tree interoperates with upstream, range reads stay bounded, cache replay needs no host", async () => {
  const bytes = randomBytes(9 * 1024 ** 2 + 7),
    f = await fixture(bytes);
  try {
    const get = async (hash: Uint8Array) => f.index.get(toHex(hash));
    const upstream = new HashTree({
      store: {
        get,
        put: async () => false,
        has: async (h) => !!(await get(h)),
        delete: async () => false,
      } satisfies Store,
    });
    expect(
      await upstream.readFileRange(
        { hash: fromHex(f.tree.root) },
        8388600,
        8388640,
      ),
    ).toEqual(new Uint8Array(bytes.slice(8388600, 8388640)));
    let offline = false;
    const source = new HashtreeSource(
      "http://localhost/map",
      f.tree,
      undefined,
      { offline: () => offline },
    );
    expect(await source.read(8388600, 8388640)).toEqual(
      new Uint8Array(bytes.slice(8388600, 8388640)),
    );
    expect(source.networkBytes).toBeLessThan(145000);
    const before = source.networkBytes;
    offline = true;
    f.host.stop(true);
    expect(await source.read(8388600, 8388640)).toEqual(
      new Uint8Array(bytes.slice(8388600, 8388640)),
    );
    expect(source.networkBytes).toBe(before);
    await expect(source.read(1000000, 1000100)).rejects.toThrow(
      "Missing cached",
    );
  } finally {
    await f.close();
  }
});
test("bad provider data fails over by hash; unavailable blocks are retried, modified archives fail", async () => {
  const bytes = randomBytes(100000),
    f = await fixture(bytes);
  const bad = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("wrong bytes"),
  });
  try {
    const source = new HashtreeSource("http://localhost/map", {
      ...f.tree,
      providers: [bad.url.href.slice(0, -1), ...f.tree.providers],
    });
    expect(await source.read(11, 200)).toEqual(
      new Uint8Array(bytes.slice(11, 200)),
    );
    expect(source.failovers).toBeGreaterThan(0);
    await writeFile(f.path, new Uint8Array(bytes.length));
    await expect(f.index.get(f.tree.root)).rejects.toThrow("changed");
    await expect(source.read(-1, 20)).rejects.toThrow("Invalid");
  } finally {
    bad.stop(true);
    await f.close();
  }
});
test("signed discovery rejects tampering/expiry and delivers offers through a real local relay", async () => {
  const data = await workspaceFixture(),
    f = await fixture(data.bytes),
    relay = localRelay();
  const key = generateSecretKey(),
    abort = new AbortController();
  try {
    const offer: MapOffer = {
      id: "test",
      url: "http://localhost/map.atlas",
      api: "http://localhost/api",
      bytes: f.tree.bytes,
      manifest: data.reader.index.manifest,
      hashtree: f.tree,
    };
    const event = mapAnnouncement(offer, key);
    expect(parseAnnouncement(event).offer.hashtree?.root).toBe(f.tree.root);
    const altered = JSON.parse(JSON.stringify(event));
    altered.content += " ";
    expect(() => parseAnnouncement(altered)).toThrow();
    expect(() =>
      parseAnnouncement(event, event.created_at + 8 * 86400),
    ).toThrow("Expired");
    const received = Promise.withResolvers<MapOffer>();
    const stop = await watchMaps(
      relay.url,
      [event.pubkey],
      received.resolve,
      abort.signal,
    );
    await publishAnnouncement(relay.url, event);
    expect((await received.promise).manifest.snapshot).toBe(
      offer.manifest.snapshot,
    );
    stop();
  } finally {
    abort.abort();
    relay.close();
    data.reader.dispose();
    await f.close();
  }
});
test("two Hashtree maps prepare one AI workspace and query after both providers close", async () => {
  const a = await workspaceFixture([16, 48, 16.012, 48.02]),
    b = await workspaceFixture([16.008, 48, 16.02, 48.02]);
  const fa = await fixture(a.bytes),
    fb = await fixture(b.bytes);
  let readers: AtlasReader[] = [];
  try {
    const sources = [
      new HashtreeSource("http://localhost/a", fa.tree),
      new HashtreeSource("http://localhost/b", fb.tree),
    ];
    readers = await Promise.all(sources.map((s) => new AtlasReader(s).open()));
    const w = new AtlasWorkspace(readers);
    const p = await w.prepare({
      bounds: [16, 48, 16.02, 48.02],
      families: ["locations", "buildings"],
      required: ["addresses", "poi-tags"],
    });
    const before = sources.reduce((n, s) => n + s.networkBytes, 0);
    fa.host.stop(true);
    fb.host.stop(true);
    const q = w.query({
      workspace: p.workspace,
      where: [{ field: "tags.amenity", op: "eq", value: "cafe" }],
    });
    expect(q.count).toBe(2);
    expect(q.sourceBytes).toBe(0);
    expect(sources.reduce((n, s) => n + s.networkBytes, 0)).toBe(before);
    w.clear();
  } finally {
    readers.forEach((r) => r.dispose());
    a.reader.dispose();
    b.reader.dispose();
    await fa.close();
    await fb.close();
  }
});
test("host publication survives restart and provides a signed, readable archive without copying leaf bytes", async () => {
  const f = await workspaceFixture(),
    dir = await mkdtemp("/tmp/atlas-publish-");
  const path = `${dir}/map.atlas`;
  await Bun.write(path, f.bytes);
  const maps = () => [
    {
      id: "demo",
      path,
      offer: {
        id: "demo",
        url: "/maps/demo.atlas",
        api: "/api",
        bytes: f.bytes.length,
        manifest: f.reader.index.manifest,
      },
    },
  ];
  let d = await MapDiscovery.open(`${dir}/discovery`, () => true, maps);
  try {
    const job = await d.publish("demo", "http://localhost:3100");
    await d.settled();
    expect(job.state).toBe("ready");
    expect(parseAnnouncement(job.event).offer.manifest.snapshot).toBe(
      f.reader.index.manifest.snapshot,
    );
    const root = d.offer("demo")!.root;
    const pubkey = d.pubkey;
    await d.close();
    d = await MapDiscovery.open(`${dir}/discovery`, () => true, maps);
    expect(d.pubkey).toBe(pubkey);
    expect(d.offer("demo")!.root).toBe(root);
    const r = await d.handle(
      new Request(`http://localhost/hashtree/${root}/${root}`),
    );
    expect(r!.status).toBe(200);
    await d.remove("demo");
    expect(d.offer("demo")).toBeUndefined();
    expect(
      (await d.handle(
        new Request(`http://localhost/hashtree/${root}/${root}`),
      ))!.status,
    ).toBe(404);
  } finally {
    await d.close();
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
