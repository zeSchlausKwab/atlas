import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  inspectSource,
  trustedSourceUrl,
  cacheSource,
  validateSourceResponse,
  type CachedSource,
  type SourceFetch,
} from "../packages/provisioning/src/source-cache";
const body = new TextEncoder().encode("an immutable osm source fixture");
const source: CachedSource = {
  id: "a".repeat(32),
  kind: "planet",
  name: "Fixture",
  url: "https://planet.openstreetmap.org/pbf/planet-261005.osm.pbf",
  bytes: body.length,
  etag: '"fixture"',
  md5: createHash("md5").update(body).digest("hex"),
  lastModified: "Thu, 08 Oct 2026 16:41:59 GMT",
  inspectedAt: new Date().toISOString(),
};
const response = (offset = 0, data = body.slice(offset)) =>
  new Response(new Uint8Array(data), {
    status: offset ? 206 : 200,
    headers: {
      etag: source.etag,
      "content-length": String(source.bytes - offset),
      ...(offset
        ? {
            "content-range": `bytes ${offset}-${source.bytes - 1}/${source.bytes}`,
          }
        : {}),
    },
  });
test("planet inspection follows only official mirrors and pins size, identity and checksum", async () => {
  const mirror =
    "https://osm-planet-eu-central-1.s3.dualstack.eu-central-1.amazonaws.com/planet/pbf/2026/planet-261005.osm.pbf";
  const mock = (async (u: string | URL | Request) => {
    const url = String(u);
    if (url.includes("latest"))
      return new Response(null, { status: 302, headers: { location: mirror } });
    if (url.endsWith("md5"))
      return new Response(source.md5 + "  planet-261005.osm.pbf\n");
    return new Response(null, {
      headers: {
        etag: source.etag,
        "last-modified": source.lastModified,
        "content-length": String(source.bytes),
      },
    });
  }) as SourceFetch;
  const plan = await inspectSource("planet", mock);
  expect(plan.url).toBe(mirror);
  expect(plan.bytes).toBe(body.length);
  expect(plan.md5).toBe(source.md5);
  for (const url of [
    "http://planet.openstreetmap.org/pbf/planet-261005.osm.pbf",
    "https://attacker.example/planet.osm.pbf",
    mirror + "?x=1",
    "https://planet.openstreetmap.org/pbf/full-history/planet-261005.osm.pbf",
    "https://download.geofabrik.de/asia-latest.osm.pbf",
  ])
    expect(() => trustedSourceUrl(url)).toThrow();
  await expect(
    inspectSource(
      "planet",
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        })) as SourceFetch,
    ),
  ).rejects.toThrow("Untrusted");
});
test("resuming appends exact ranges, verifies publisher checksum and publishes atomically", async () => {
  const directory = await mkdtemp("/tmp/atlas-large-source-");
  try {
    const part = `${directory}/${source.id}.osm.pbf.part`;
    await Bun.write(part, body.slice(0, 7));
    const states: string[] = [];
    const result = await cacheSource(
      source,
      directory,
      new AbortController().signal,
      async (state) => {
        states.push(state);
      },
      (async (_u, init) => {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=7-");
        expect(new Headers(init?.headers).get("if-match")).toBe(source.etag);
        expect(await Bun.file(part.replace(/\.part$/, "")).exists()).toBe(
          false,
        );
        return response(7);
      }) as SourceFetch,
    );
    expect(new Uint8Array(await Bun.file(result.path).arrayBuffer())).toEqual(
      body,
    );
    expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await Bun.file(part).exists()).toBe(false);
    expect(states).toContain("verifying");
    expect((await Bun.file(result.path + ".source.json").json()).md5).toBe(
      source.md5,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("ignored ranges and changed source identities do not corrupt a saved partial", async () => {
  const directory = await mkdtemp("/tmp/atlas-large-source-reject-");
  try {
    const part = `${directory}/${source.id}.osm.pbf.part`;
    await Bun.write(part, body.slice(0, 7));
    await expect(
      cacheSource(
        source,
        directory,
        new AbortController().signal,
        async () => {},
        (async () => response()) as SourceFetch,
      ),
    ).rejects.toThrow("expected 206");
    expect(new Uint8Array(await Bun.file(part).arrayBuffer())).toEqual(
      body.slice(0, 7),
    );
    const changed = response(7);
    changed.headers.set("etag", '"changed"');
    expect(() => validateSourceResponse(changed, source, 7)).toThrow(
      "identity changed",
    );
    const wrong = response(7);
    wrong.headers.set(
      "content-range",
      `bytes 6-${source.bytes - 1}/${source.bytes}`,
    );
    expect(() => validateSourceResponse(wrong, source, 7)).toThrow(
      "Invalid resume range",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("checksum failure never publishes a source and cancellation preserves partial bytes", async () => {
  const directory = await mkdtemp("/tmp/atlas-large-source-integrity-");
  try {
    const file = `${directory}/${source.id}.osm.pbf`;
    await expect(
      cacheSource(
        { ...source, md5: "0".repeat(32) },
        directory,
        new AbortController().signal,
        async () => {},
        (async () => response()) as SourceFetch,
      ),
    ).rejects.toThrow("checksum mismatch");
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await Bun.file(file + ".part").exists()).toBe(false);
    const abort = new AbortController();
    await expect(
      cacheSource(
        source,
        directory,
        abort.signal,
        async (state) => {
          if (state === "verifying") abort.abort();
        },
        (async () => response()) as SourceFetch,
      ),
    ).rejects.toThrow();
    expect(await Bun.file(file).exists()).toBe(false);
    expect(Bun.file(file + ".part").size).toBe(body.length);
    const result = await cacheSource(
      source,
      directory,
      new AbortController().signal,
      async () => {},
      (async () => {
        throw new Error("Completed file must not redownload");
      }) as SourceFetch,
    );
    expect(await Bun.file(result.path).exists()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
