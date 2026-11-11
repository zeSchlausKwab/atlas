import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dir, "../../..");
const result = await Bun.build({
  entrypoints: [resolve(root, "apps/android/viewer/main.ts")],
  target: "browser",
  format: "iife",
  minify: true,
  plugins: [
    {
      name: "embedded-atlas-wasm",
      setup(build) {
        build.onResolve({ filter: /^atlas-renderer-wasm$/ }, () => ({
          path: "wasm",
          namespace: "embedded",
        }));
        build.onLoad({ filter: /.*/, namespace: "embedded" }, async () => ({
          contents: `export default ${JSON.stringify(Buffer.from(await Bun.file(resolve(root, "packages/renderer/pkg/atlas_renderer_bg.wasm")).arrayBuffer()).toString("base64"))}`,
          loader: "js",
        }));
      },
    },
  ],
});
if (!result.success)
  throw new AggregateError(result.logs, "Build Android renderer");
const js = await result.outputs[0]!.text();
const integrity = createHash("sha256").update(js).digest("base64");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${integrity}' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'"><title>Atlas native viewer</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f3f1e9;font:14px system-ui;color:#263c32}#map,.map-overlay,.raster-plane{position:absolute;inset:0;width:100%;height:100%;touch-action:none}.map-overlay,.raster-plane{pointer-events:none}nav{position:absolute;right:12px;top:12px;display:grid;gap:6px}button{background:#fffdf5;color:#315d70;border:1px solid #bdc9c9;border-radius:8px;min-width:48px;min-height:48px;font-size:24px}#status{position:absolute;bottom:26px;left:10px;right:10px;padding:8px;background:#fffdf5e8;border-radius:6px;pointer-events:none}footer{position:absolute;bottom:2px;right:5px;font-size:10px;background:#fffdf5d9}</style><canvas id="map" aria-label="Atlas map. Drag to pan and pinch to zoom."></canvas><nav><button id="plus" aria-label="Zoom in">+</button><button id="minus" aria-label="Zoom out">−</button><button id="fit" aria-label="Fit map">⌖</button></nav><div id="status" role="status">Choose a map in Android</div><footer>© OpenStreetMap contributors · ODbL</footer><script type="module">${js}</script></html>`;
const dir = resolve(root, "apps/android/app/build/viewer-assets");
await mkdir(dir, { recursive: true });
await Bun.write(resolve(dir, "viewer.html"), html);
console.log(`Embedded renderer: ${html.length} bytes; no remote assets`);

const preset = process.env.ATLAS_NATIVE_CONNECTION_FILE;
if (preset) {
  const c = await Bun.file(resolve(preset)).json();
  if (
    Object.keys(c).sort().join(",") !==
      "address,catalog,peer,publisher,transport" ||
    !["tcp", "udp"].includes(c.transport) ||
    !/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(c.peer) ||
    !["catalog", "publisher"].every((k) => /^[a-f0-9]{64}$/.test(c[k]))
  )
    throw new Error("Expected only public native connection settings");
  const profiles = [c];
  if (process.env.ATLAS_NATIVE_ALTERNATE_CONNECTION_FILE) {
    const other = await Bun.file(
      resolve(process.env.ATLAS_NATIVE_ALTERNATE_CONNECTION_FILE),
    ).json();
    if (
      Object.keys(other).sort().join(",") !==
        "address,catalog,peer,publisher,transport" ||
      !["tcp", "udp"].includes(other.transport) ||
      other.transport === c.transport ||
      !["catalog", "publisher"].every((k) => /^[a-f0-9]{64}$/.test(other[k])) ||
      !/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(other.peer)
    )
      throw new Error("Expected public alternate native connection settings");
    profiles.push(other);
  }
  await Bun.write(resolve(dir, "connections.json"), JSON.stringify(profiles));
  await Bun.write(resolve(dir, "connection.json"), JSON.stringify(c));
} else {
  await (
    await import("node:fs/promises")
  ).rm(resolve(dir, "connections.json"), { force: true });
  await (
    await import("node:fs/promises")
  ).rm(resolve(dir, "connection.json"), { force: true });
}
