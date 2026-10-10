import { mkdir, cp, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugins, loadPlugins } from "./plugins";
import { serverAddress } from "../apps/shared/urls";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildBrowserApp(kind: "client" | "host") {
  const directory = resolve(root, "dist", kind);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const assets = kind === "client" ? await buildPlugins(root) : [];
  const plugins = kind === "client" ? await loadPlugins(root, assets) : [];
  const installed = assets.map((asset, i) => ({
    ...asset,
    descriptor: plugins[i]!.plugin.descriptor,
  }));
  const entries =
    kind === "client"
      ? [
          "main",
          "offline-worker",
          "routing-worker",
          "plugin-worker",
          "compose",
        ].map((n) => `apps/web/src/${n}.ts`)
      : ["apps/host/src/host.ts"];
  const result = await Bun.build({
    entrypoints: entries.map((p) => resolve(root, p)),
    outdir: directory,
    target: "browser",
    minify: true,
    sourcemap: "external",
    define: { ATLAS_PLUGIN_ASSETS: JSON.stringify(installed) },
  });
  if (!result.success)
    throw new AggregateError(result.logs, `${kind} build failed`);
  const files = [
    [
      kind === "client" ? "apps/web/index.html" : "apps/host/index.html",
      "index.html",
    ],
    ["apps/shared/styles.css", "styles.css"],
    [
      "packages/renderer/pkg/atlas_renderer_bg.wasm",
      "wasm/atlas_renderer_bg.wasm",
    ],
    ...(kind === "client"
      ? [
          ["apps/web/sw.js", "sw.js"],
          ["apps/web/compose.html", "compose.html"],
          [
            "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
            "wasm/atlas_routing_wasm_bg.wasm",
          ],
          ...assets.map((a) => [`dist${a.url}`, a.url.slice(1)]),
        ]
      : [
          ["node_modules/maplibre-gl/dist/maplibre-gl.css", "maplibre.css"],
          [
            "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
            "maplibre/maplibre-gl-worker.mjs",
          ],
          [
            "node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs",
            "maplibre/maplibre-gl-shared.mjs",
          ],
        ]),
  ];
  for (const [from, to] of files) {
    const destination = resolve(directory, to!);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(root, from!), destination, { recursive: true });
  }
  if (kind === "client")
    await Bun.write(
      resolve(directory, "client-config.json"),
      JSON.stringify(
        {
          serverUrl: serverAddress(
            process.env.ATLAS_SERVER_URL ?? "http://192.168.0.179:3100/",
          ),
        },
        null,
        2,
      ),
    );
  console.log(`Built standalone ${kind} assets in ${directory}`);
  return directory;
}
if (import.meta.main) {
  const kind = process.argv[2];
  if (kind && !["client", "host"].includes(kind))
    throw new Error("Use client or host");
  if (!kind || kind === "client") await buildBrowserApp("client");
  if (!kind || kind === "host") await buildBrowserApp("host");
}
