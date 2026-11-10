import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { generateSecretKey } from "nostr-tools/pure";
import {
  defaultPresentation,
  parseViewRecipe,
  parsePresentation,
} from "../packages/views/src/index";
import {
  viewAnnouncement,
  parseViewAnnouncement,
} from "../packages/views/src/announcement";
import { MapDiscovery } from "../apps/server/discovery";
import { workspaceFixture } from "./helpers/workspace-fixture";
const recipe = () =>
  parseViewRecipe({
    version: 1,
    id: "explore",
    name: "Explore",
    coverage: false,
    presentation: defaultPresentation(),
    sources: [
      {
        url: "http://localhost/maps/demo.atlas",
        root: "a".repeat(64),
        enabled: true,
        layers: ["water"],
        labels: false,
        rasterLayers: {},
      },
    ],
  });
test("view contract separates appearance, display selection and on-demand tools; owns its input", () => {
  const input = recipe();
  input.presentation.tools = ["search"];
  input.presentation.layers = ["water"];
  const result = parseViewRecipe(input);
  input.presentation.style.colors.water = "#000000";
  expect(result.presentation.style.colors.water).not.toBe("#000000");
  expect(result.presentation.tools).toEqual(["search"]);
  expect(result.sources[0]!.layers).toEqual(["water"]);
  expect(() =>
    parseViewRecipe({
      ...input,
      sources: [{ ...input.sources[0], root: "latest" }],
    }),
  ).toThrow("pinned");
  expect(() =>
    parseViewRecipe({
      ...input,
      sources: [input.sources[0], input.sources[0]],
    }),
  ).toThrow("distinct");
  expect(() =>
    parsePresentation({ ...input.presentation, tools: ["preload-all"] }),
  ).toThrow();
  expect(() =>
    parseViewRecipe({
      ...input,
      camera: { center: [NaN, 0], zoom: 10, pitch: 0, bearing: 0 },
    }),
  ).toThrow();
  expect(() =>
    parsePresentation({
      ...input.presentation,
      style: { ...input.presentation.style, script: "alert(1)" },
    }),
  ).toThrow();
});
test("signed views bind recipes to the publisher and reject tampering", () => {
  const event = viewAnnouncement(recipe(), generateSecretKey());
  expect(parseViewAnnouncement(event, event.pubkey).recipe.name).toBe(
    "Explore",
  );
  const changed = {
    ...event,
    content: event.content.replace("Explore", "Altered"),
  };
  expect(() => parseViewAnnouncement(changed)).toThrow("signed");
  expect(() => parseViewAnnouncement(event, "b".repeat(64))).toThrow("signed");
});
test("publisher saves independent revisions, preserves map hashes and old links across restart; rejects missing roots and cross-origin writes", async () => {
  const f = await workspaceFixture(),
    dir = await mkdtemp("/tmp/atlas-views-"),
    path = `${dir}/map.atlas`;
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
  let host = await MapDiscovery.open(`${dir}/discovery`, () => true, maps);
  const request = (body: unknown, origin = "http://localhost") =>
    new Request("http://localhost/admin/views", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await host.publish("demo", "http://localhost");
    await host.settled();
    const root = host.offer("demo")!.root;
    const v = recipe();
    v.sources[0]!.root = root;
    v.sources[0]!.layers = [...(f.reader.index.manifest.tileLayers ?? [])];
    const originalBytes = await Bun.file(path).arrayBuffer();
    expect(
      (await host.handle(request({ recipe: v }, "http://evil.example")))
        ?.status,
    ).toBe(403);
    const first = await host.handle(request({ recipe: v, makeDefault: true }));
    expect(first?.status).toBe(201);
    const a = (await first!.json()).event;
    v.presentation.style.colors.water = "#123456";
    const second = await host.handle(request({ recipe: v, makeDefault: true }));
    expect(second?.status).toBe(201);
    const b = (await second!.json()).event;
    expect(b.id).not.toBe(a.id);
    expect(host.offer("demo")!.root).toBe(root);
    expect(await Bun.file(path).arrayBuffer()).toEqual(originalBytes);
    expect(
      (
        await host.handle(
          request({
            recipe: {
              ...v,
              sources: [{ ...v.sources[0], root: "f".repeat(64) }],
            },
          }),
        )
      )?.status,
    ).toBe(400);
    await host.close();
    host = await MapDiscovery.open(`${dir}/discovery`, () => true, maps);
    const catalog = await (await host.handle(
      new Request("http://localhost/views"),
    ))!.json();
    expect(catalog.defaultView).toBe("explore");
    expect(catalog.views[0].id).toBe(b.id);
    const old = await (await host.handle(
      new Request(`http://localhost/views/${a.id}`),
    ))!.json();
    expect(
      parseViewAnnouncement(old).recipe.presentation.style.colors.water,
    ).not.toBe("#123456");
    const discovery = await (await host.handle(
      new Request("http://localhost/discovery"),
    ))!.json();
    expect(discovery.views[0].id).toBe(b.id);
    const cleared = await host.handle(
      request({ recipe: v, makeDefault: false }),
    );
    expect(cleared?.status).toBe(201);
    const noDefault = await (await host.handle(
      new Request("http://localhost/views"),
    ))!.json();
    expect(noDefault.defaultView).toBeUndefined();
  } finally {
    await host.close();
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe reads support a separate client origin, administration remains same-origin", async () => {
  const { publicCors, corsPolicy } = await import("../apps/server/cors");
  for (const path of ["/views", "/views/" + "a".repeat(64)]) {
    const r = await publicCors(
      new Request("http://localhost:3100" + path, {
        headers: { Origin: "http://localhost:5173" },
      }),
      corsPolicy("*"),
      async () => Response.json({ ok: true }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  }
  const r = await publicCors(
    new Request("http://localhost:3100/admin/views", {
      headers: { Origin: "http://localhost:5173" },
    }),
    corsPolicy("*"),
    async () => Response.json({ ok: true }),
  );
  expect(r.status).toBe(403);
});

test("Nostr discovery offers view recipes without replacing map identities", async () => {
  const { localRelay } = await import("./helpers/nostr-relay");
  const { watchMaps, publishAnnouncement } = await import(
    "../packages/hashtree/src/discovery"
  );
  const relay = localRelay(),
    abort = new AbortController(),
    event = viewAnnouncement(recipe(), generateSecretKey());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = Promise.withResolvers<string>();
  const close = await watchMaps(
    relay.url,
    [event.pubkey],
    () => {
      throw Error("A view must not be accepted as a map");
    },
    abort.signal,
    () => {},
    (v) => result.resolve(v.event.id),
  );
  try {
    await publishAnnouncement(relay.url, event);
    expect(
      await Promise.race([
        result.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("No view received")), 3000);
        }),
      ]),
    ).toBe(event.id);
  } finally {
    clearTimeout(timer);
    close();
    abort.abort();
    relay.close();
  }
});
