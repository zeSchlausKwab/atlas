import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import entries from "../atlas.plugins";
import type { Plugin } from "../packages/operations/src/registry";
export interface PluginAsset { url: string; implementation: string }
/** Build once; native host and browser worker execute identical immutable JS bytes. */
export async function buildPlugins(root: string) {
  const assets: PluginAsset[] = [];
  for (const entry of entries) {
    const built = await Bun.build({ entrypoints: [resolve(root, entry)], target: "browser", minify: true });
    if (!built.success || built.outputs.length !== 1) throw new Error(`Plugin build failed: ${entry}: ${built.logs}`);
    const bytes = await built.outputs[0]!.arrayBuffer();
    const implementation = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const url = `/plugins/${implementation}.js`, file = resolve(root, `dist${url}`);
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, bytes);
    assets.push({ url, implementation });
  }
  return assets;
}
export async function loadPlugins(root: string, assets: PluginAsset[]) {
  return Promise.all(assets.map(async a => ({ plugin: (await import(resolve(root, `dist${a.url}`))).default as Plugin, implementation: a.implementation })));
}
