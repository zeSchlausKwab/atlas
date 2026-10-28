import { SourceCache } from "../apps/server/source-cache";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  inspectSource,
  trustedSourceUrl,
  cacheSource,
  cacheSourceWithRetries,
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
        expect(new Headers(init?.headers).get("range")).toBe(
          `bytes=7-${source.bytes - 1}`,
        );
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

test("large sources use bounded HTTP ranges and resume from the last complete bytes", async () => {
  const directory = await mkdtemp("/tmp/atlas-bounded-source-");
  const chunkBytes = 16 * 1024 ** 2;
  const payload = new Uint8Array(chunkBytes + 19).fill(67);
  const large = {
    ...source,
    bytes: payload.length,
    md5: createHash("md5").update(payload).digest("hex"),
  };
  const requests: string[] = [];
  try {
    await Bun.write(
      `${directory}/${large.id}.osm.pbf.part`,
      payload.slice(0, 7),
    );
    const result = await cacheSource(
      large,
      directory,
      new AbortController().signal,
      async () => {},
      async (_url, init) => {
        const range = new Headers(init?.headers).get("range")!;
        requests.push(range);
        // The old open-ended response allows the runtime to buffer the remaining planet.
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        expect(match).not.toBeNull();
        const start = Number(match![1]),
          end = Number(match![2]);
        expect(end - start + 1).toBeLessThanOrEqual(chunkBytes);
        return new Response(payload.slice(start, end + 1), {
          status: 206,
          headers: {
            etag: large.etag,
            "content-length": String(end - start + 1),
            "content-range": `bytes ${start}-${end}/${large.bytes}`,
          },
        });
      },
    );
    expect(requests).toEqual([
      `bytes=7-${chunkBytes + 6}`,
      `bytes=${chunkBytes + 7}-${large.bytes - 1}`,
    ]);
    expect(result.sha256).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporary failures retry from persisted bytes without restarting the file", async () => {
  const directory = await mkdtemp("/tmp/atlas-source-retry-");
  const ranges: string[] = [],
    waits: number[] = [],
    retried: number[] = [];
  try {
    const result = await cacheSourceWithRetries(
      source,
      directory,
      new AbortController().signal,
      async (state, completed) => {
        if (state === "retrying") retried.push(completed);
      },
      async (_url, init) => {
        ranges.push(new Headers(init?.headers).get("range")!);
        return ranges.length === 1
          ? response(0, body.slice(0, 7))
          : response(7);
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(ranges).toEqual([
      `bytes=0-${source.bytes - 1}`,
      `bytes=7-${source.bytes - 1}`,
    ]);
    expect(waits).toEqual([5000]);
    expect(retried).toEqual([7]);
    expect(new Uint8Array(await Bun.file(result.path).arrayBuffer())).toEqual(
      body,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries are bounded and stop on pause or changed source identity", async () => {
  const directory = await mkdtemp("/tmp/atlas-source-retry-stop-");
  try {
    let calls = 0;
    const waits: number[] = [];
    await expect(
      cacheSourceWithRetries(
        source,
        directory,
        new AbortController().signal,
        async () => {},
        async () => {
          calls++;
          return new Response(null, { status: 503 });
        },
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toThrow("HTTP 503");
    expect(calls).toBe(6);
    expect(waits).toEqual([5000, 10000, 20000, 40000, 60000]);
    calls = 0;
    const abort = new AbortController();
    await expect(
      cacheSourceWithRetries(
        source,
        directory,
        abort.signal,
        async (state) => {
          if (state === "retrying") abort.abort();
        },
        async () => {
          calls++;
          return response(0, body.slice(0, 7));
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(Bun.file(`${directory}/${source.id}.osm.pbf.part`).size).toBe(7);
    calls = 0;
    await expect(
      cacheSourceWithRetries(
        source,
        directory,
        new AbortController().signal,
        async () => {},
        async () => {
          calls++;
          const r = response(7);
          r.headers.set("etag", '"changed"');
          return r;
        },
        async () => {
          throw new Error("Must not retry identity failure");
        },
      ),
    ).rejects.toThrow("identity changed");
    expect(calls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a vanished worker is reported as failed, while an intentional pause stays paused", async () => {
  const directory = await mkdtemp("/tmp/atlas-source-worker-status-");
  const manager = new SourceCache(directory);
  const record = `${directory}/${source.id}.json`;
  try {
    const job = {
      ...source,
      state: "downloading",
      completed: 0,
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      message: "Downloading",
    };
    await Bun.write(record, JSON.stringify(job));
    await Bun.write(`${directory}/${source.id}.osm.pbf.part`, body.slice(0, 7));
    const failed = (await manager.list())[0]!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("stopped unexpectedly");
    expect(failed.completed).toBe(7);
    await Bun.write(
      record,
      JSON.stringify({ ...job, state: "paused", message: "Paused by user" }),
    );
    const paused = (await manager.list())[0]!;
    expect(paused.state).toBe("paused");
    expect(paused.error).toBeUndefined();
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("waiting downloads survive status checks and can be removed without touching partial bytes", async () => {
  const directory = await mkdtemp("/tmp/atlas-source-queue-"),
    manager = new SourceCache(directory);
  try {
    const job = {
      ...source,
      state: "waiting",
      completed: 7,
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      message: "Queued",
    };
    await Bun.write(directory + "/" + source.id + ".json", JSON.stringify(job));
    await Bun.write(
      directory + "/" + source.id + ".osm.pbf.part",
      body.slice(0, 7),
    );
    expect((await manager.list())[0]!.state).toBe("waiting");
    const result = await manager.handle(
      new Request("http://localhost/admin/sources/pause", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: source.id }),
      }),
      "127.0.0.1",
    );
    expect(result.status).toBe(200);
    expect((await manager.list())[0]!.state).toBe("paused");
    expect(
      await Bun.file(directory + "/" + source.id + ".osm.pbf.part").bytes(),
    ).toEqual(body.slice(0, 7));
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("source queue runs real workers sequentially and starts a persisted download after restart", async () => {
  const directory = await mkdtemp("/tmp/atlas-download-dispatch-");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const requested = new Promise<void>((r) => {
    entered = r;
  });
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === "/first") {
        entered();
        await gate;
      }
      return response();
    },
  });
  let manager = new SourceCache(directory);
  const until = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("Queue did not progress");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    const first = { ...source, url: `http://127.0.0.1:${server.port}/first` };
    const second = {
      ...source,
      id: "b".repeat(32),
      url: `http://127.0.0.1:${server.port}/second`,
    };
    // Direct fixture injection avoids remote inspection; all worker requests stay on loopback.
    await (manager as any).launch(first);
    await requested;
    expect((await (manager as any).launch(second)).state).toBe("waiting");
    expect(seen).toEqual(["/first"]);
    release();
    await until(
      async () =>
        (await manager.list()).find((j) => j.id === first.id)?.state ===
        "ready",
    );
    await manager.close();
    manager = new SourceCache(directory);
    manager.startQueue();
    await until(
      async () =>
        (await manager.list()).find((j) => j.id === second.id)?.state ===
        "ready",
    );
    expect(seen).toEqual(["/first", "/second"]);
    expect(
      await Bun.file(directory + "/" + second.id + ".osm.pbf").bytes(),
    ).toEqual(body);
  } finally {
    release();
    await manager.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
