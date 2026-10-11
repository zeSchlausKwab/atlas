import { beforeAll, expect, test } from "bun:test";
import { OperationSession } from "../apps/web/src/operations";
import { createApiHandler } from "../apps/server/api";
import {
  AtlasReader,
  FileSource,
  HttpSource,
} from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import { AtlasEngine } from "../packages/operations/src/index";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { transportFixture, points } from "./helpers/transport-fixture";
import type { Manifest, TransportMode } from "../packages/format/src/index";

beforeAll(async () => {
  initSync({
    module: await Bun.file(
      new URL(
        "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
        import.meta.url,
      ),
    ).arrayBuffer(),
  });
});

async function fixture(
  profiles: TransportMode[] = ["walking", "cycling", "driving"],
) {
  const base = await transportFixture();
  base.router.destroy();
  const manifest: Omit<Manifest, "snapshot"> = {
    ...base.manifest,
    transport: {
      ...base.manifest.transport!,
      graphSnapshot: "a".repeat(64),
      profiles: Object.fromEntries(
        profiles.map((p) => [p, base.manifest.transport!.profiles[p]]),
      ),
    },
  };
  if (!profiles.length) {
    delete manifest.transport;
    manifest.capabilities = [];
  }
  const encode = (m: Omit<Manifest, "snapshot">) =>
    encodePackage(
      m,
      base.inputs.filter(
        (b) => !!m.transport?.profiles[b.key.split("/")[1] as TransportMode],
      ),
      { paged: true },
    );
  const bytes = await encode(manifest);
  const local = () => new AtlasReader(new FileSource(new Blob([bytes]))).open();
  const serverReader = await local();
  const engine = new AtlasEngine(serverReader, async () => {});
  const api = createApiHandler(engine);
  const requests: {
    path: string;
    body: { snapshot: string; input: { profile: string } };
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/selected/api/")) {
        requests.push({ path, body: await request.clone().json() });
        return api(request);
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(
        request.headers.get("range") ?? "",
      );
      if (path !== "/selected.atlas" || !range)
        return new Response(null, { status: 404 });
      const start = +range[1]!,
        end = +range[2]!;
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          ETag: '"fixture"',
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    },
  });
  const reader = await new AtlasReader(
    new HttpSource(
      new URL("/selected.atlas", server.url).href,
      new URL("/selected/api", server.url).href,
    ),
  ).open();
  return {
    reader,
    requests,
    local,
    async peer(compatible = true) {
      const bytes = await encode({
        ...base.manifest,
        transport: {
          ...base.manifest.transport!,
          graphSnapshot: (compatible ? "a" : "b").repeat(64),
        },
      });
      return new AtlasReader(new FileSource(new Blob([bytes]))).open();
    },
    close() {
      engine.destroy();
      server.stop(true);
    },
  };
}

test("a single map in the composer enables server routing controls", async () => {
  const f = await fixture();
  const session = new OperationSession(f.reader, () => {}, [
    { id: "selected", reader: f.reader },
  ]);
  try {
    expect(session.routingAvailable).toBe(true);
    session.configure("server", ["routing"]);
    expect(session.routingAvailable).toBe(true);
    expect(session.isochroneAvailable).toBe(true);
    expect(session.transportProfiles).toEqual([
      "walking",
      "cycling",
      "driving",
    ]);
  } finally {
    session.destroy();
    f.close();
  }
});

test("composed server routes and isochrones use the selected API without downloading the graph", async () => {
  const f = await fixture();
  const session = new OperationSession(f.reader, () => {}, [
    { id: "selected", reader: f.reader },
  ]);
  try {
    session.configure("server", ["routing"]);
    session.profile = "walking";
    const route = await session.route(points[0]!, points[2]!);
    expect(route.status).toBe("found");
    expect(route.execution.side).toBe("server");
    expect((await session.isochrone(points[0]!, [30, 60, 120])).status).toBe(
      "reachable",
    );
    expect(f.requests.map((r) => r.path)).toEqual([
      "/selected/api/route",
      "/selected/api/isochrone",
    ]);
    expect(
      f.requests.every(
        (r) =>
          r.body.snapshot === f.reader.index.manifest.snapshot &&
          r.body.input.profile === "walking",
      ),
    ).toBe(true);
    expect(f.reader.bytesByPurpose.routing).toBe(0);
    expect(session.apiRequests).toBe(2);
    f.reader.offline = true;
    await expect(session.route(points[0]!, points[2]!)).rejects.toThrow(
      "needs a connection",
    );
    expect(session.apiRequests).toBe(2);
    f.reader.offline = false;
    session.configure("server", []);
    expect(session.routingAvailable).toBe(false);
    expect(session.isochroneAvailable).toBe(false);
    expect(() => session.route(points[0]!, points[2]!)).toThrow("disabled");
  } finally {
    session.destroy();
    f.close();
  }
});

test("server profiles follow Tool source; device profiles follow the composition", async () => {
  const f = await fixture(["walking"]);
  const peer = await f.peer();
  const session = new OperationSession(f.reader, () => {}, [
    { id: "selected", reader: f.reader },
    { id: "peer", reader: peer },
  ]);
  try {
    expect(session.transportProfiles).toEqual([
      "walking",
      "cycling",
      "driving",
    ]);
    session.profile = "driving";
    session.configure("server", ["routing"]);
    expect(session.transportProfiles).toEqual(["walking"]);
    expect(session.profile as TransportMode).toBe("walking");
    expect(session.routingAvailable).toBe(true);
    expect((await session.route(points[0]!, points[2]!)).status).toBe("found");
    session.configure("device", ["routing"]);
    expect(session.transportProfiles).toEqual([
      "walking",
      "cycling",
      "driving",
    ]);
    expect(session.routingAvailable).toBe(true);
  } finally {
    session.destroy();
    f.close();
  }
});

test("an incompatible client composition does not block routing on the selected server map", async () => {
  const f = await fixture();
  const session = new OperationSession(f.reader, () => {}, [
    { id: "selected", reader: f.reader },
    { id: "peer", reader: await f.peer(false) },
  ]);
  try {
    expect(session.compositionError).toContain("not compatible");
    expect(session.routingAvailable).toBe(false);
    session.configure("server", ["routing"]);
    expect(session.routingAvailable).toBe(true);
    expect((await session.route(points[0]!, points[2]!)).status).toBe("found");
    session.configure("device", ["routing"]);
    expect(session.routingAvailable).toBe(false);
    expect(session.isochroneAvailable).toBe(false);
    expect(() => session.route(points[0]!, points[2]!)).toThrow(
      "not compatible",
    );
  } finally {
    session.destroy();
    f.close();
  }
});

test("peer routing cannot supply a server capability missing from Tool source", async () => {
  const f = await fixture([]);
  const session = new OperationSession(f.reader, () => {}, [
    { id: "peer", reader: await f.peer() },
  ]);
  try {
    expect(session.routingAvailable).toBe(true);
    session.configure("server", ["routing"]);
    expect(session.transportProfiles).toEqual([]);
    expect(session.routingAvailable).toBe(false);
    expect(session.isochroneAvailable).toBe(false);
    expect(() => session.route(points[0]!, points[2]!)).toThrow(
      "not available",
    );
    expect(f.requests).toHaveLength(0);
  } finally {
    session.destroy();
    f.close();
  }
});

test("local file sessions stay on device when server execution is requested", async () => {
  const f = await fixture();
  const reader = await f.local();
  const session = new OperationSession(reader, () => {}, [
    { id: "local", reader },
  ]);
  try {
    session.configure("server", ["routing"]);
    expect(session.mode).toBe("device");
    expect(session.routingAvailable).toBe(true);
    expect(session.remote).toBeUndefined();
  } finally {
    session.destroy();
    f.close();
  }
});
