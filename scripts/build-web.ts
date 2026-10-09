import { buildPlugins, loadPlugins } from "./plugins";
const root = new URL("../", import.meta.url).pathname;
const assets = await buildPlugins(root),
  plugins = await loadPlugins(root, assets);
const installed = assets.map((asset, i) => ({
  ...asset,
  descriptor: plugins[i]!.plugin.descriptor,
}));
const result = await Bun.build({
  entrypoints: [
    "apps/web/src/main.ts",
    "apps/web/src/offline-worker.ts",
    "apps/web/src/routing-worker.ts",
    "apps/web/src/plugin-worker.ts",
    "apps/web/src/host.ts",
    "apps/web/src/compose.ts",
  ],
  outdir: "dist",
  target: "browser",
  minify: true,
  sourcemap: "external",
  define: { ATLAS_PLUGIN_ASSETS: JSON.stringify(installed) },
});
if (!result.success) throw new AggregateError(result.logs, "Web build failed");
console.log(
  `Built ${result.outputs.length} web artifacts and ${assets.length} pinned plugins`,
);
