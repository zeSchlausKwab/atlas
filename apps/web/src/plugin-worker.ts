import { installedPlugins } from "../../../packages/operations/src/installed";
import { OperationRegistry, type Plugin } from "../../../packages/operations/src/registry";
import { AtlasFeatures } from "../../../packages/features/src/index";
import type { AtlasReader } from "../../../packages/format/src/reader";
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
function rpc(method: string, args: unknown[]) {
  return new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); postMessage({ type: "read", id, method, args }); });
}
self.onmessage = async ({ data: m }) => {
  if (m.type === "reply") {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p?.reject(new Error(m.error)); else p?.resolve(m.value);
    return;
  }
  if (m.type !== "run") return;
  try {
    const asset = installedPlugins.find(p => p.descriptor.id === m.ref.id && p.implementation === m.ref.implementation && p.descriptor.version === m.ref.version);
    if (!asset) throw new Error("This plugin implementation is not installed on this device.");
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error("Plugin code is unavailable; open this tool online once before using it offline.");
    const bytes = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
    if (digest !== asset.implementation) throw new Error("Plugin code fingerprint mismatch");
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    let plugin: Plugin;
    try { plugin = (await import(/* @vite-ignore */ url)).default; } finally { URL.revokeObjectURL(url); }
    const reader = { index: { manifest: m.manifest }, spatial: (...args: unknown[]) => rpc("spatial", args), block: (key: string) => rpc("block", [key]) } as unknown as AtlasReader;
    const features = new AtlasFeatures(reader);
    const registry = new OperationRegistry(m.manifest, { scanFeatures: (q, signal) => features.scan(q, signal) });
    registry.register(plugin, asset.implementation);
    const result = await registry.invoke(m.ref, m.input, undefined, message => postMessage({ type: "progress", message }));
    postMessage({ type: "result", result });
  } catch (e) { postMessage({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
};
