import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import init from "../../packages/routing/pkg/atlas_routing_wasm";
import { AtlasReader } from "../../packages/format/src/reader";
import { AtlasEngine } from "../../packages/operations/src/index";
import { createApiHandler } from "./api";
import { servePackage } from "./ranges";
import { PackageSource } from "./package-source";
const root = fileURLToPath(new URL("../../", import.meta.url));
const mapPath = resolve(
  root,
  process.env.ATLAS_FILE ??
    ((await Bun.file(resolve(root, "data/vienna-plus.atlas")).exists())
      ? "data/vienna-plus.atlas"
      : "data/liechtenstein.atlas"),
);
const snapshot = await PackageSource.open(mapPath);
const etag = snapshot.etag;
const built = await Bun.build({
  entrypoints: [
    resolve(root, "apps/web/src/main.ts"),
    resolve(root, "apps/web/src/offline-worker.ts"),
    resolve(root, "apps/web/src/routing-worker.ts"),
  ],
  outdir: resolve(root, "dist"),
  target: "browser",
  minify: false,
  sourcemap: "linked",
});
if (!built.success) throw new AggregateError(built.logs, "Web build failed");
const engine = new AtlasEngine(
  await new AtlasReader(snapshot).open(),
  async () =>
    init({
      module_or_path: await Bun.file(
        resolve(root, "packages/routing/pkg/atlas_routing_wasm_bg.wasm"),
      ).arrayBuffer(),
    }),
);
const api = createApiHandler(engine);
const routes = new Map([
  [
    "/wasm/atlas_renderer_bg.wasm",
    ["packages/renderer/pkg/atlas_renderer_bg.wasm", "application/wasm"],
  ],
  [
    "/routing-worker.js",
    ["dist/routing-worker.js", "text/javascript; charset=utf-8"],
  ],
  ["/sw.js", ["apps/web/sw.js", "text/javascript; charset=utf-8"]],
  [
    "/offline-worker.js",
    ["dist/offline-worker.js", "text/javascript; charset=utf-8"],
  ],
  ["/", ["apps/web/index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["apps/web/styles.css", "text/css; charset=utf-8"]],
  ["/main.js", ["dist/main.js", "text/javascript; charset=utf-8"]],
  ["/main.js.map", ["dist/main.js.map", "application/json"]],
  [
    "/wasm/atlas_routing_wasm_bg.wasm",
    ["packages/routing/pkg/atlas_routing_wasm_bg.wasm", "application/wasm"],
  ],
]);
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3100),
  maxRequestBodySize: 16384,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api(request);
    if (path === "/maps/demo.atlas") {
      try {
        await snapshot.assertUnchanged();
        return servePackage(request, snapshot, etag);
      } catch (error) {
        return new Response(String(error), { status: 503 });
      }
    }
    if (path === "/health")
      return Response.json({ ok: true, bytes: snapshot.size, etag });
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    const asset = routes.get(path);
    if (asset && ["GET", "HEAD"].includes(request.method))
      return new Response(
        request.method === "HEAD" ? null : Bun.file(resolve(root, asset[0]!)),
        { headers: { "Content-Type": asset[1]!, "Cache-Control": "no-store" } },
      );
    return new Response("Not found", { status: 404 });
  },
});
console.log(
  `ATLAS lab → ${server.url}\nPackage: ${mapPath} (${(snapshot.size / 1024 / 1024).toFixed(2)} MiB)\nServing a pinned file descriptor; restart to load a regenerated package.`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await server.stop(true);
    engine.destroy();
    await snapshot.close();
    process.exit(0);
  });
