import { test, expect } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { MapDiscovery } from "../apps/server/discovery";
import {
  FipsHosting,
  parseHostingSettings,
  mapRpcHandler,
} from "../apps/server/fips-hosting";
import {
  parseAnnouncement,
  publishAnnouncement,
} from "../packages/hashtree/src/discovery";
import { defaultPresentation } from "../packages/views/src/index";
import { workspaceFixture } from "./helpers/workspace-fixture";
const peerId = "02" + "1".repeat(64);
const provider = {
  peerId,
  seedUrls: ["wss://seed.example/fips"],
  servicePort: 39018,
  rpcPort: 39019,
};
const settings = {
  enabled: true,
  httpEnabled: false,
  seedUrls: provider.seedUrls,
  relayUrls: [],
};
async function fixture(
  publishRelay?: NonNullable<
    Parameters<typeof MapDiscovery.open>[3]
  >["publishRelay"],
) {
  const directory = await mkdtemp("/tmp/atlas-fips-host-"),
    a = await workspaceFixture(),
    b = await workspaceFixture(undefined, "37");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const maps = [a, b].map((f, n) => ({
    id: ids[n]!,
    path: join(directory, `${ids[n]}.atlas`),
    offer: {
      id: ids[n]!,
      url: `/maps/${ids[n]}.atlas`,
      api: `/maps/${ids[n]}/api`,
      bytes: f.bytes.length,
      manifest: f.reader.index.manifest,
    },
  }));
  await Promise.all(maps.map((m, n) => Bun.write(m.path, [a, b][n]!.bytes)));
  let visible = [...maps];
  const discovery = await MapDiscovery.open(
    join(directory, "discovery"),
    () => true,
    () => visible,
    { publishRelay },
  );
  await discovery.setDelivery({
    origin: "http://localhost",
    httpEnabled: false,
    fips: [provider],
    relays: [],
  });
  for (const m of maps) {
    await discovery.publish(m.id, "http://localhost");
    await discovery.settled();
  }
  return {
    directory,
    discovery,
    maps,
    hide: (id: string) => {
      visible = visible.filter((m) => m.id !== id);
    },
    close: async () => {
      await discovery.close();
      a.reader.dispose();
      b.reader.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("one provider serves every enabled library root; HTTP is optional and changing delivery preserves archive/index bytes", async () => {
  const f = await fixture();
  try {
    const offers = f.discovery.publishedOffers();
    expect(offers).toHaveLength(2);
    for (const offer of offers) {
      expect(offer.url).toBe(`htree://${offer.hashtree!.root}`);
      expect(offer.api).toBeUndefined();
      expect(offer.hashtree!.providers).toEqual([]);
      expect(offer.hashtree!.fips).toEqual([provider]);
      expect(
        parseAnnouncement(f.discovery.jobs.get(offer.id)!.event).offer,
      ).toEqual(offer);
      expect(await f.discovery.getBlob(offer.hashtree!.root)).not.toBeNull();
    }
    const first = offers[0]!,
      root = first.hashtree!.root;
    expect(
      (await f.discovery.handle(
        new Request(`http://localhost/hashtree/${root}/${root}`),
      ))!.status,
    ).toBe(403);
    const indexPath = join(f.directory, "discovery", `${first.id}.sqlite`),
      before = await stat(indexPath);
    await f.discovery.setDelivery({
      origin: "http://localhost",
      httpEnabled: true,
      fips: [provider],
      relays: [],
    });
    expect((await stat(indexPath)).mtimeMs).toBe(before.mtimeMs);
    expect(f.discovery.offer(first.id)!.root).toBe(root);
    expect(
      (await f.discovery.handle(
        new Request(`http://localhost/hashtree/${root}/${root}`),
      ))!.status,
    ).toBe(200);
    f.hide(first.id);
    expect(await f.discovery.getBlob(root)).toBeNull();
    await f.discovery.remove(first.id);
    const withdrawals = JSON.parse(
      await readFile(
        join(f.directory, "discovery", "withdrawals.json"),
        "utf8",
      ),
    );
    expect(withdrawals).toHaveLength(1);
    expect(verifyEvent(withdrawals[0])).toBe(true);
    expect(withdrawals[0].tags).toContainEqual([
      "a",
      `30064:${f.discovery.pubkey}:atlas/${first.id}`,
    ]);
    expect(f.discovery.publishedOffers()).toHaveLength(1);
    const remaining = f.discovery.publishedOffers()[0]!;
    const previous = f.discovery.jobs.get(remaining.id)!.event!;
    // Renewal keeps root identity while issuing a fresh, verifiable offer.
    f.discovery.jobs.get(remaining.id)!.event = {
      ...previous,
      created_at: previous.created_at - 86401,
    };
    await Promise.all([
      f.discovery.refreshAnnouncements(),
      f.discovery.refreshAnnouncements(),
    ]);
    const renewed = f.discovery.jobs.get(remaining.id)!.event!;
    expect(renewed.created_at).toBeGreaterThan(previous.created_at);
    expect(parseAnnouncement(renewed).offer.hashtree!.root).toBe(
      remaining.hashtree!.root,
    );
  } finally {
    await f.close();
  }
});
test("RPC pins a served root, forwards operation arguments and snapshot headers, rejects admin/path escapes", async () => {
  const f = await fixture();
  try {
    const root = f.discovery.publishedOffers()[0]!.hashtree!.root;
    const seen: Request[] = [];
    const rpc = mapRpcHandler(f.discovery, async (request) => {
      seen.push(request);
      return Response.json(
        { ok: true },
        { headers: { "X-Atlas-Snapshot": "snapshot" } },
      );
    });
    const signal = new AbortController().signal;
    expect(
      await rpc({ root, path: "/capabilities", method: "GET" }, peerId, signal),
    ).toMatchObject({
      status: 200,
      body: { ok: true },
      headers: { "x-atlas-snapshot": "snapshot" },
    });
    const input = { snapshot: "pinned", input: { from: [1, 2], to: [3, 4] } };
    await rpc(
      { root, path: "route", method: "POST", body: input },
      peerId,
      signal,
    );
    expect(await seen[1]!.json()).toEqual(input);
    expect(
      (
        await rpc(
          { root, path: "fixture.lakes", method: "POST", body: input },
          peerId,
          signal,
        )
      ).status,
    ).toBe(200);
    for (const path of [
      "../admin/fips",
      "https://elsewhere/api",
      "route?url=evil",
      "../x",
    ])
      expect(
        (await rpc({ root, path, method: "GET" }, peerId, signal)).status,
      ).toBe(400);
    expect(
      (
        await rpc(
          { root: "f".repeat(64), path: "capabilities", method: "GET" },
          peerId,
          signal,
        )
      ).status,
    ).toBe(404);
    expect(seen).toHaveLength(3);
    f.hide(f.maps[0]!.id);
    expect(
      (await rpc({ root, path: "capabilities", method: "GET" }, peerId, signal))
        .status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
test("delivery settings persist, honor same-origin administration and withdraw FIPS offers while disabled", async () => {
  const f = await fixture();
  let started = 0,
    stopped = 0;
  const start = async () => {
    started++;
    return {
      peerId,
      status: () => ({
        peerId,
        connectedPeers: ["seed"],
        requests: 0,
        bytesServed: 0,
      }),
      stop: async () => {
        stopped++;
      },
    };
  };
  const open = () =>
    FipsHosting.open({
      directory: join(f.directory, "fips"),
      origin: "http://localhost",
      discovery: f.discovery,
      access: () => true,
      rpc: async () => ({ status: 200, body: {} }),
      start,
      defaults: settings,
    });
  let host = await open();
  try {
    expect(host.httpEnabled).toBe(false);
    expect(started).toBe(1);
    const request = (origin: string, body: unknown) =>
      new Request("http://localhost/admin/fips", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await host.handle(request("http://elsewhere", settings)))!.status,
    ).toBe(403);
    expect(
      (await host.handle(
        request("http://localhost", {
          ...settings,
          seedUrls: ["wss://user:secret@seed.example"],
        }),
      ))!.status,
    ).toBe(400);
    expect(
      (await host.handle(
        request("http://localhost", { ...settings, enabled: false }),
      ))!.status,
    ).toBe(200);
    expect(stopped).toBe(1);
    expect(f.discovery.publishedOffers()).toEqual([]);
    await host.close();
    host = await open();
    expect(host.settings.enabled).toBe(false);
    expect(started).toBe(1);
    expect(
      (await host.handle(request("http://localhost", settings)))!.status,
    ).toBe(200);
    expect(f.discovery.publishedOffers()).toHaveLength(2);
  } finally {
    await host.close();
    await f.close();
  }
});
test("default view selection is signed and moves between recipes", async () => {
  const f = await fixture();
  try {
    const offer = f.discovery.publishedOffers()[0]!;
    const recipe = (id: string) => ({
      version: 1,
      id,
      name: id,
      sources: [
        {
          url: offer.url,
          root: offer.hashtree!.root,
          enabled: true,
          layers: [],
          labels: true,
        },
      ],
      presentation: defaultPresentation(),
      coverage: true,
    });
    const publish = async (id: string) =>
      (
        await (await f.discovery.handle(
          new Request("http://localhost/admin/views", {
            method: "POST",
            headers: {
              Origin: "http://localhost",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ recipe: recipe(id), makeDefault: true }),
          }),
        ))!.json()
      ).event;
    const a = await publish("first");
    expect(a.tags).toContainEqual(["default", "true"]);
    const b = await publish("second");
    expect(b.tags).toContainEqual(["default", "true"]);
    const previous = f.discovery.views.get("first")!;
    expect(previous.tags.some((t) => t[0] === "default")).toBe(false);
    expect(previous.created_at).toBeGreaterThan(a.created_at);
    expect(verifyEvent(previous)).toBe(true);
  } finally {
    await f.close();
  }
});
test("settings reject invalid endpoints and support explicit offline/local operation", () => {
  expect(
    parseHostingSettings({ ...settings, enabled: false, seedUrls: [] }).enabled,
  ).toBe(false);
  expect(() => parseHostingSettings({ ...settings, seedUrls: [] })).toThrow(
    "bootstrap",
  );
  expect(() =>
    parseHostingSettings({ ...settings, relayUrls: ["https://relay.example"] }),
  ).toThrow("relay");
});

test("an indexed map with delivery off survives restart and publishes without reindexing", async () => {
  const directory = await mkdtemp("/tmp/atlas-fips-unpublished-");
  const fixture = await workspaceFixture();
  const id = "33333333-3333-4333-8333-333333333333";
  const path = join(directory, "map.atlas");
  await Bun.write(path, fixture.bytes);
  const maps = () => [
    {
      id,
      path,
      offer: {
        id,
        url: "/maps/" + id + ".atlas",
        bytes: fixture.bytes.length,
        manifest: fixture.reader.index.manifest,
      },
    },
  ];
  let d = await MapDiscovery.open(
    join(directory, "discovery"),
    () => true,
    maps,
  );
  try {
    await d.setDelivery({
      origin: "http://localhost",
      httpEnabled: false,
      fips: [],
      relays: [],
    });
    await d.publish(id, "http://localhost");
    await d.settled();
    expect(d.jobs.get(id)?.state).toBe("ready");
    expect(d.publishedOffers()).toHaveLength(0);
    const index = join(directory, "discovery", id + ".sqlite"),
      before = await stat(index);
    await d.close();
    d = await MapDiscovery.open(join(directory, "discovery"), () => true, maps);
    expect(d.jobs.get(id)?.state).toBe("ready");
    await d.setDelivery({
      origin: "http://localhost",
      httpEnabled: false,
      fips: [provider],
      relays: [],
    });
    expect(d.publishedOffers()).toHaveLength(1);
    expect((await stat(index)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await d.close();
    fixture.reader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("slow discovery relays never block startup/settings, and superseded publications are cancelled", async () => {
  const sent: Array<{
    event: Event;
    signal: AbortSignal;
    fail(error: Error): void;
  }> = [];
  const f = await fixture(async (_url, event, _timeout, signal) => {
    await new Promise<void>((_resolve, reject) => {
      sent.push({ event, signal: signal!, fail: reject });
      if (signal!.aborted) reject(signal!.reason);
      else
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
    });
  });
  const remote = { ...settings, relayUrls: ["wss://unreachable.example"] };
  const timely = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Blocked behind relay network I/O")),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const host = await timely(
    FipsHosting.open({
      directory: join(f.directory, "fips"),
      origin: "http://localhost",
      discovery: f.discovery,
      access: () => true,
      defaults: remote,
      rpc: async () => ({ status: 200 }),
      start: async () => ({
        peerId,
        status: () => ({
          peerId,
          connectedPeers: ["seed"],
          requests: 0,
          bytesServed: 0,
        }),
        stop: async () => {},
      }),
    }),
  );
  try {
    expect(host.status().state).toBe("connected");
    expect(f.discovery.publishedOffers()).toHaveLength(2);
    expect(sent.filter((s) => s.event.kind === 30064)).toHaveLength(2);
    const firstEvents = sent.filter((s) => s.event.kind === 30064);
    const change = (enabled: boolean) =>
      timely(
        host.handle(
          new Request("http://localhost/admin/fips", {
            method: "POST",
            headers: {
              Origin: "http://localhost",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...remote, enabled }),
          }),
        ),
      );
    expect((await change(false))!.status).toBe(200);
    expect(firstEvents.every((s) => s.signal.aborted)).toBe(true);
    expect(f.discovery.publishedOffers()).toHaveLength(0);
    expect(sent.some((s) => s.event.kind === 5)).toBe(true);
    expect((await change(true))!.status).toBe(200);
    expect(
      sent.filter((s) => s.event.kind === 5).every((s) => s.signal.aborted),
    ).toBe(true);
    expect(f.discovery.publishedOffers()).toHaveLength(2);
    for (const job of f.discovery.jobs.values()) {
      expect(job.relayPending).toBe(true);
      expect(job.relayErrors).toEqual([]);
      expect(job.event!.created_at).toBeGreaterThan(
        firstEvents.find((s) =>
          s.event.tags.some((t) => t[0] === "d" && t[1] === `atlas/${job.id}`),
        )!.event.created_at,
      );
    }
    // Fail only obsolete sends: their delayed failures must not replace the new pending status.
    for (const old of firstEvents)
      old.fail(new Error("late old network error"));
    await f.discovery.refreshAnnouncements();
    expect(
      [...f.discovery.jobs.values()].every((j) => !j.relayErrors?.length),
    ).toBe(true);
    await timely(host.close());
    await timely(f.close());
    expect(sent.every((s) => s.signal.aborted)).toBe(true);
  } catch (error) {
    await host.close();
    await f.close();
    throw error;
  }
});

test("relay publication abort closes a real websocket without waiting for an acknowledgement timeout", async () => {
  const f = await fixture();
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, srv) =>
      srv.upgrade(request) ? undefined : new Response(null, { status: 426 }),
    websocket: {
      message: (_ws, raw) => {
        if (JSON.parse(String(raw))[0] === "EVENT") received();
      },
    },
  });
  const controller = new AbortController();
  try {
    const publication = publishAnnouncement(
      `ws://127.0.0.1:${server.port}`,
      f.discovery.jobs.get(f.maps[0]!.id)!.event!,
      10_000,
      controller.signal,
    );
    await waiting;
    const started = performance.now();
    controller.abort(new Error("Superseded publication"));
    await expect(publication).rejects.toThrow("Superseded publication");
    expect(performance.now() - started).toBeLessThan(500);
  } finally {
    controller.abort();
    await server.stop(true);
    await f.close();
  }
});
