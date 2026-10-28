#!/usr/bin/env bun
/** Loopback-only rehearsal; reuses production byte ranges and operation handlers. */
import { PackageSource } from "../apps/server/package-source";
import { servePackage } from "../apps/server/ranges";
import { createApiHandler } from "../apps/server/api";
import { publicCors } from "../apps/server/cors";
import { AtlasReader } from "../packages/format/src/reader";
import { AtlasEngine } from "../packages/operations/src/index";
import init from "../packages/routing/pkg/atlas_routing_wasm";
const files = process.argv.slice(2);
if (!files.length)
  files.push(
    "data/pair-rehearsal/west-analysis.atlas",
    "data/pair-rehearsal/east-analysis.atlas",
  );
const port = Number(process.env.ATLAS_REHEARSAL_PORT ?? 5175);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid ATLAS_REHEARSAL_PORT");
const maps: {
  id: string;
  source: PackageSource;
  engine: AtlasEngine;
  api: ReturnType<typeof createApiHandler>;
}[] = [];
for (let i = 0; i < files.length; i++) {
  const source = await PackageSource.open(files[i]!);
  const reader = await new AtlasReader(source).open();
  const engine = new AtlasEngine(reader, () =>
    init({
      module_or_path: Bun.file(
        "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
      ).arrayBuffer(),
    }),
  );
  maps.push({ id: String(i), source, engine, api: createApiHandler(engine) });
}
const allowed = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  `http://127.0.0.1:${port}`,
]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 255,
  fetch: (request) =>
    publicCors(request, allowed, async () => {
      const path = new URL(request.url).pathname;
      if (path === "/catalog")
        return Response.json({
          version: 1,
          maps: maps.map((m) => ({
            id: m.id,
            url: `/maps/${m.id}.atlas`,
            api: `/maps/${m.id}/api`,
            bytes: m.source.size,
            manifest: m.engine.reader.index.manifest,
          })),
        });
      if (path === "/health")
        return Response.json({
          status: "ok",
          rehearsal: true,
          maps: maps.length,
        });
      const id = /^\/maps\/(\d+)(?:\.atlas|\/api\/)/.exec(path)?.[1],
        map = maps.find((m) => m.id === id);
      if (map && path.endsWith(".atlas"))
        return servePackage(request, map.source, map.source.etag);
      if (map && path.includes("/api/")) return map.api(request);
      if (path.startsWith("/api/")) return maps[0]!.api(request);
      return new Response("Not found", { status: 404 });
    }),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.stop(true);
    for (const m of maps) m.engine.destroy();
    process.exit(0);
  });
console.log(
  `Analysis demo: http://127.0.0.1:5173/?server=${encodeURIComponent(`http://127.0.0.1:${port}/`)}&maps=${maps.map((m) => m.id).join(",")}#tab=chat`,
);
