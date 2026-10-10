import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHandler } from "../apps/web/server";
import { corsPolicy, publicCors } from "../apps/server/cors";
import { clientLink, serverAddress } from "../apps/shared/urls";
import { buildBrowserApp } from "../scripts/build-web";
import { AtlasReader, HttpSource } from "../packages/format/src/reader";
import { RemoteOperations } from "../packages/operations/src/index";
import { pluginFixture } from "./helpers/plugin-fixture";

let directory: string;
let backend: Bun.Subprocess | undefined;
let frontend: ReturnType<typeof Bun.serve> | undefined;
let serverUrl: string;
let stderr: Promise<string> | undefined;
let bytes: Uint8Array;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "atlas-separate-apps-"));
  const fixture = await pluginFixture();
  bytes = fixture.bytes;
  fixture.engine.destroy();
  await Bun.write(join(directory, "fixture.atlas"), bytes);
  await buildBrowserApp("host");
  const clientDirectory = await buildBrowserApp("client");
  backend = Bun.spawn([process.execPath, "apps/server/index.ts"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      ATLAS_FILE: join(directory, "fixture.atlas"),
      ATLAS_DATA_DIR: directory,
      ATLAS_HOST_POLICY: join(directory, "policy.json"),
      ATLAS_CVM_SECRET: "",
      ATLAS_CORS_ORIGINS: "*",
      ATLAS_CLIENT_URL: "http://127.0.0.1:5173",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  stderr = new Response(backend.stderr as ReadableStream).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    serverUrl = await Promise.race([
      (async () => {
        let output = "";
        const stream = (
          backend!.stdout as ReadableStream<Uint8Array>
        ).getReader();
        try {
          while (true) {
            const { done, value } = await stream.read();
            if (done) throw new Error(`Server exited: ${await stderr}`);
            output += new TextDecoder().decode(value);
            const match = output.match(
              /ATLAS server → (http:\/\/127\.0\.0\.1:\d+)/,
            );
            if (match) return match[1]!;
          }
        } finally {
          stream.releaseLock();
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Server startup timed out")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  frontend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: clientHandler(clientDirectory, serverUrl),
  });
}, 30000);

afterAll(async () => {
  frontend?.stop(true);
  backend?.kill();
  await backend?.exited;
  await stderr;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("separate HTTP apps: client serves only its shell, backend exposes data and host console", async () => {
  const client = frontend!.url;
  expect((await (await fetch(new URL("/health", client))).json()).service).toBe(
    "atlas-client",
  );
  expect((await (await fetch(serverUrl + "/health")).json()).service).toBe(
    "atlas-server",
  );
  expect((await (await fetch(serverUrl + "/")).json()).hostConsole).toBe(
    "/host",
  );
  expect(
    (await (await fetch(new URL("/client-config.json", client))).json())
      .serverUrl,
  ).toBe(serverUrl + "/");
  expect(await (await fetch(new URL("/", client))).text()).toContain(
    'id="server-address"',
  );
  for (const path of [
    "/catalog",
    "/maps/demo.atlas",
    "/api/capabilities",
    "/admin/operations",
    "/host",
    "/host.js",
  ])
    expect((await fetch(new URL(path, client))).status).toBe(404);
  for (const path of [
    "/main.js",
    "/routing-worker.js",
    "/sw.js",
    "/compose",
    "/client-config.json",
    "/.env",
    "/%2e%2e%2fpackage.json",
  ])
    expect((await fetch(serverUrl + path)).status).toBe(404);
  expect((await fetch(serverUrl + "/host")).status).toBe(200);
  expect((await fetch(serverUrl + "/host.js")).status).toBe(200);
  const catalog = await (await fetch(serverUrl + "/catalog")).json();
  expect(new URL(catalog.maps[0].url, serverUrl).origin).toBe(
    new URL(serverUrl).origin,
  );
});

test("cross-origin ranges expose identity and support conditional reads, including errors", async () => {
  const Origin = frontend!.url.origin;
  const preflight = await fetch(serverUrl + "/maps/demo.atlas", {
    method: "OPTIONS",
    headers: {
      Origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range,if-match",
    },
  });
  expect(preflight.status).toBe(204);
  const first = await fetch(serverUrl + "/maps/demo.atlas", {
    headers: { Origin, Range: "bytes=0-31" },
  });
  expect(first.status).toBe(206);
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes.slice(0, 32));
  expect(first.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(first.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
  expect(first.headers.get("Access-Control-Expose-Headers")).toContain(
    "Content-Range",
  );
  const second = await fetch(serverUrl + "/maps/demo.atlas", {
    headers: {
      Origin,
      Range: "bytes=32-63",
      "If-Match": first.headers.get("ETag")!,
    },
  });
  expect(second.status).toBe(206);
  await second.arrayBuffer();
  const changed = await fetch(serverUrl + "/maps/demo.atlas", {
    headers: { Origin, Range: "bytes=0-31", "If-Match": '"wrong"' },
  });
  expect(changed.status).toBe(412);
  expect(changed.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

test("public compute accepts cross-origin JSON; admin does not grant the client access", async () => {
  const Origin = frontend!.url.origin;
  const preflight = await fetch(serverUrl + "/api/features", {
    method: "OPTIONS",
    headers: {
      Origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  expect(preflight.status).toBe(204);
  const reader = await new AtlasReader(
    new HttpSource(serverUrl + "/maps/demo.atlas"),
  ).open();
  const snapshot = reader.index.manifest.snapshot;
  const result = await fetch(serverUrl + "/api/features", {
    method: "POST",
    headers: { Origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      snapshot,
      input: { kind: "water", bounds: [9, 47, 9.2, 47.2] },
    }),
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("X-Atlas-Snapshot")).toBe(snapshot);
  expect(result.headers.get("Access-Control-Expose-Headers")).toContain(
    "X-Atlas-Snapshot",
  );
  const json = await result.json();
  expect(json.execution.side).toBe("server");
  expect(json.result.matched).toBe(2);
  const remote = new RemoteOperations(serverUrl + "/api", snapshot);
  expect(
    (
      await remote.call("features", {
        kind: "water",
        bounds: [9, 47, 9.2, 47.2],
      })
    ).result.matched,
  ).toBe(2);
  expect(reader.bytesByPurpose.features).toBe(0);
  reader.dispose();
  for (const method of ["GET", "OPTIONS", "POST"]) {
    const admin = await fetch(serverUrl + "/admin/operations", {
      method,
      headers: { Origin },
    });
    expect(admin.status).toBe(403);
    expect(admin.headers.has("Access-Control-Allow-Origin")).toBe(false);
  }
  expect((await fetch(serverUrl + "/admin/operations")).status).toBe(200);
});

test("restricted CORS rejects unlisted origins before executing operations; own origin still works", async () => {
  let calls = 0;
  const handle = async () => {
    calls++;
    return Response.json({ ok: true });
  };
  const policy = corsPolicy("https://client.example");
  const request = (origin: string) =>
    new Request("https://maps.example/api/peak", {
      method: "POST",
      headers: { Origin: origin },
    });
  expect(
    (await publicCors(request("https://other.example"), policy, handle)).status,
  ).toBe(403);
  expect(calls).toBe(0);
  expect(
    (
      await publicCors(request("https://client.example"), policy, handle)
    ).headers.get("Access-Control-Allow-Origin"),
  ).toBe("https://client.example");
  expect(
    (await publicCors(request("https://maps.example"), policy, handle)).status,
  ).toBe(200);
  expect(calls).toBe(2);
});

test("host links keep map selection on the independent consumer and retain backend identity", () => {
  const selected = new URL(
    clientLink(
      "https://client.example/?source=old&api=old",
      "https://maps.example/atlas",
      { maps: ["a", "b"] },
    ),
  );
  expect(selected.origin).toBe("https://client.example");
  expect(selected.searchParams.get("server")).toBe(
    "https://maps.example/atlas/",
  );
  expect(selected.searchParams.get("maps")).toBe("a,b");
  expect(selected.searchParams.has("source")).toBe(false);
  expect(selected.hash).toBe("#tab=composer");
  expect(() => serverAddress("file:///tmp/map.atlas")).toThrow();
});
