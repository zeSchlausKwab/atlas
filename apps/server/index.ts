import { Federation } from "./federation";
import { ArchiveUploads } from "./archive-uploads";
import { IMAGE_MAX_BYTES } from "../../packages/raster/src/image-plan";
import { limitedBody } from "./request-body";
import { MapDiscovery } from "./discovery";
import type { MapOffer } from "../../packages/format/src/catalog";
import { SourceCache } from "./source-cache";
import { adminAccess, ADMIN_DENIED } from "./admin-access";
import { Preparations } from "./preparations";
import { HostedLibrary } from "./library";
import { buildPlugins, loadPlugins } from "../../scripts/plugins";
import { OperationHost } from "../../packages/operations/src/host";
import { hostPolicy } from "./policy";
import { startContextVM } from "./contextvm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import init from "../../packages/routing/pkg/atlas_routing_wasm";
import { AtlasReader } from "../../packages/format/src/reader";
import { AtlasEngine } from "../../packages/operations/src/index";
import { createApiHandler } from "./api";
import { servePackage } from "./ranges";
import { PackageSource } from "./package-source";
import { staticFiles } from "../shared/static";
import { serverAddress } from "../shared/urls";
import { corsPolicy, publicCors } from "./cors";
const root = fileURLToPath(new URL("../../", import.meta.url));
const dataDir = resolve(root, process.env.ATLAS_DATA_DIR ?? "data");
const mapPath = process.env.ATLAS_FILE
  ? resolve(root, process.env.ATLAS_FILE)
  : resolve(
      dataDir,
      (await Bun.file(resolve(dataDir, "vienna-plus.atlas")).exists())
        ? "vienna-plus.atlas"
        : (await Bun.file(resolve(dataDir, "liechtenstein.atlas")).exists())
          ? "liechtenstein.atlas"
          : "local-demo.atlas",
    );
if (!(await Bun.file(mapPath).exists()))
  throw new Error(
    `Missing map: ${mapPath}. Run bun run setup, or set ATLAS_FILE to an existing .atlas file.`,
  );
const snapshot = await PackageSource.open(mapPath);
const etag = snapshot.etag;
const pluginAssets = await buildPlugins(root);
const plugins = await loadPlugins(root, pluginAssets);
const engine = new AtlasEngine(
  await new AtlasReader(snapshot).open(),
  async () =>
    init({
      module_or_path: await Bun.file(
        resolve(root, "packages/routing/pkg/atlas_routing_wasm_bg.wasm"),
      ).arrayBuffer(),
    }),
);
for (const p of plugins) engine.registry.register(p.plugin, p.implementation);
const host = new OperationHost(engine);
let cvm: Awaited<ReturnType<typeof startContextVM>>;
const access = adminAccess(
  process.env.ATLAS_ADMIN_ORIGINS,
  process.env.ATLAS_ADMIN_SUBNETS,
);
const policy = await hostPolicy(
  host,
  process.env.ATLAS_HOST_POLICY
    ? resolve(root, process.env.ATLAS_HOST_POLICY)
    : resolve(dataDir, "host-policy.json"),
  () => {
    void cvm?.sendToolListChanged().catch(console.error);
  },
  access,
);
cvm = await startContextVM(host);
const api = createApiHandler(engine, host);
const preparations = await Preparations.open(
  resolve(dataDir, "hosted"),
  mapPath,
  engine.reader.index.manifest,
  access,
);
const archiveUploads = await ArchiveUploads.open(
  resolve(dataDir, "imports"),
  preparations,
  access,
);
const sourceCache = new SourceCache(
  resolve(dataDir, "sources"),
  access,
  process.env.ATLAS_SOURCE_SYSTEMD === "1",
);
sourceCache.beforeDelete = (id) => preparations.assertSourceUnused(id);
sourceCache.startQueue();
const library = new HostedLibrary(preparations, (reader) => {
  const child = new AtlasEngine(reader, async () =>
    init({
      module_or_path: await Bun.file(
        resolve(root, "packages/routing/pkg/atlas_routing_wasm_bg.wasm"),
      ).arrayBuffer(),
    }),
  );
  for (const p of plugins) child.registry.register(p.plugin, p.implementation);
  return child;
});

const discovery = await MapDiscovery.open(
  resolve(dataDir, "hashtree"),
  access,
  () => [
    {
      id: "demo",
      path: mapPath,
      offer: {
        id: "demo",
        url: "/maps/demo.atlas",
        api: "/api",
        bytes: snapshot.size,
        manifest: engine.reader.index.manifest,
      },
    },
    ...preparations.catalog().map((m) => ({
      id: m.id,
      path: preparations.path(m.id),
      offer: m as MapOffer,
    })),
  ],
);

const federation = await Federation.open(
  resolve(dataDir, "federation"),
  access,
  () => [
    {
      id: "demo",
      path: mapPath,
      offer: {
        id: "demo",
        url: "/maps/demo.atlas",
        api: "/api",
        bytes: snapshot.size,
        manifest: engine.reader.index.manifest,
      },
    },
    ...preparations.catalog().map((m) => ({
      id: m.id,
      path: preparations.path(m.id),
      offer: m as MapOffer,
    })),
  ],
  archiveUploads,
);

const releaseLibrary = preparations.beforeDelete;
preparations.beforeDelete = async (id) => {
  await discovery.remove(id);
  await releaseLibrary?.(id);
};

const hostAssets = staticFiles(resolve(root, "dist/host"));
if (!(await Bun.file(resolve(root, "dist/host/index.html")).exists()))
  throw new Error("Build the host console first: bun run build:host");
const clientUrl = serverAddress(
  process.env.ATLAS_CLIENT_URL ?? "http://127.0.0.1:5173/",
);
const origins = corsPolicy(process.env.ATLAS_CORS_ORIGINS ?? "*");
const server = Bun.serve<{
  subscriptions: Map<string, Record<string, unknown>[]>;
}>({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3100),
  maxRequestBodySize: IMAGE_MAX_BYTES + 16384,
  // Opening a large hosted package verifies its hash before responding.
  // Bun's 10-second default otherwise drops that first request mid-verification.
  idleTimeout: 120,
  websocket: discovery.websocket,
  async fetch(request, bunServer) {
    const remoteAddress = bunServer.requestIP(request)?.address;
    // The upload route authenticates before consuming its larger body. Other routes retain the old bound.
    if (
      request.body &&
      new URL(request.url).pathname !== "/admin/preparations/image" &&
      !new URL(request.url).pathname.startsWith("/admin/imports")
    ) {
      try {
        request = new Request(request, {
          body: await limitedBody(
            request,
            new URL(request.url).pathname === "/admin/views"
              ? 160 * 1024
              : 16384,
          ),
        });
      } catch {
        return Response.json({ error: "Request too large" }, { status: 413 });
      }
    }
    if (new URL(request.url).pathname === "/nostr") {
      if (bunServer.upgrade(request, { data: { subscriptions: new Map() } }))
        return;
      return new Response("Nostr WebSocket endpoint", { status: 426 });
    }
    return publicCors(request, origins, async () => {
      const path = new URL(request.url).pathname;
      if (
        path.startsWith("/admin/") &&
        request.method !== "GET" &&
        (await Bun.file(resolve(dataDir, "deploy-maintenance")).exists())
      )
        return Response.json(
          { error: "Deployment in progress. Try again shortly." },
          {
            status: 503,
            headers: { "Retry-After": "5", "Cache-Control": "no-store" },
          },
        );
      const discovered = await discovery.handle(request, remoteAddress);
      if (discovered) return discovered;
      if (path.startsWith("/admin/federation"))
        return federation.handle(request, remoteAddress);
      if (path.startsWith("/admin/imports"))
        return archiveUploads.handle(request, remoteAddress);
      if (path.startsWith("/admin/sources"))
        return sourceCache.handle(request, remoteAddress);
      if (path.startsWith("/admin/preparations"))
        return preparations.handle(request, remoteAddress);
      if (path === "/catalog" && request.method === "GET")
        return Response.json(
          {
            maps: [
              {
                id: "demo",
                url: "/maps/demo.atlas",
                api: "/api",
                bytes: snapshot.size,
                manifest: engine.reader.index.manifest,
                hashtree: discovery.offer("demo"),
              },
              ...preparations
                .catalog()
                .map((m) => ({ ...m, hashtree: discovery.offer(m.id) })),
            ],
          },
          {
            headers: {
              "Cache-Control": "no-store",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      const hosted = await library.handle(request);
      if (hosted) return hosted;
      if (path === "/admin/operations") return policy(request, remoteAddress);
      if (path.startsWith("/api/") || path.startsWith("/maps/demo/api/"))
        return api(request);
      if (path === "/maps/demo.atlas") {
        try {
          await snapshot.assertUnchanged();
          return servePackage(request, snapshot, etag);
        } catch (error) {
          return new Response(String(error), { status: 503 });
        }
      }
      if (path === "/health")
        return Response.json({
          ok: true,
          service: "atlas-server",
          release: process.env.ATLAS_RELEASE ?? null,
          bytes: snapshot.size,
          etag,
          name: engine.reader.index.manifest.name,
          contextvm: !!cvm,
        });
      if (path === "/" && request.method === "GET")
        return Response.json({
          service: "atlas-server",
          version: 1,
          catalog: "/catalog",
          hostConsole: "/host",
          clientUrl,
          health: "/health",
        });
      if (path === "/host-config.json" && request.method === "GET")
        return Response.json(
          {
            clientUrl,
            administration: {
              allowed: access(request, remoteAddress),
              message: ADMIN_DENIED,
              mode: process.env.ATLAS_ADMIN_ORIGINS
                ? "Local and trusted LAN administration"
                : "Local administration",
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      return (
        (await hostAssets(request, path === "/host" ? "/index.html" : path)) ??
        new Response("Not found", { status: 404 })
      );
    });
  },
});
// Local deployments need no external relay or account. LAN deployments pin their advertised origin.
if (process.env.ATLAS_DISCOVERY_AUTO !== "0")
  discovery.startAutomatic(
    process.env.ATLAS_PUBLIC_URL ??
      `http://${process.env.HOST === "0.0.0.0" ? "127.0.0.1" : (process.env.HOST ?? "127.0.0.1")}:${server.port}`,
  );
console.log(
  `ATLAS server → ${server.url}\nPackage: ${mapPath} (${(snapshot.size / 1024 / 1024).toFixed(2)} MiB)\nServing a pinned file descriptor; restart to load a regenerated package.`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await federation.close();
    await discovery.close();
    await sourceCache.close();
    await preparations.close();
    await library.close();
    await cvm?.close();
    await server.stop(true);
    engine.destroy();
    await snapshot.close();
    process.exit(0);
  });
