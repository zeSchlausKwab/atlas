import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { servePackage } from "./ranges";
import { sha256 } from "../../packages/format/src/index";
const root = fileURLToPath(new URL("../../", import.meta.url));
const mapPath = resolve(
  root,
  process.env.ATLAS_FILE ??
    ((await Bun.file(resolve(root, "data/vienna-plus.atlas")).exists())
      ? "data/vienna-plus.atlas"
      : "data/liechtenstein.atlas"),
);
const file = Bun.file(mapPath);
if (!(await file.exists()))
  throw new Error("Map package missing. Run bun run setup first.");
// Pin bytes for the lifetime of this process. A changed file requires a server restart.
const snapshot = new Blob([await file.arrayBuffer()]);
const etag = `"${await sha256(new Uint8Array(await snapshot.arrayBuffer()))}"`;
const built = await Bun.build({
  entrypoints: [
    resolve(root, "apps/web/src/main.ts"),
    resolve(root, "apps/web/src/offline-worker.ts"),
  ],
  outdir: resolve(root, "dist"),
  target: "browser",
  minify: false,
  sourcemap: "linked",
});
if (!built.success) throw new AggregateError(built.logs, "Web build failed");
const routes = new Map([
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
    "/wasm/atlas_renderer_bg.wasm",
    ["packages/renderer/pkg/atlas_renderer_bg.wasm", "application/wasm"],
  ],
]);
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3100),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/maps/demo.atlas")
      return servePackage(request, snapshot, etag);
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
  `ATLAS lab → ${server.url}\nPackage: ${mapPath} (${(snapshot.size / 1024 / 1024).toFixed(2)} MiB)\nServing immutable bytes; restart to load a regenerated package.`,
);
