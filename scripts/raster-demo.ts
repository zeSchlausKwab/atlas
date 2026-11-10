#!/usr/bin/env bun
/** Small, repeatable public-data proof. 0–6 relief around Europe, not elevation. */
import { resolve, join } from "node:path";
import { packRaster } from "../packages/raster/src/pack";
import { project } from "../packages/format/src/index";
import { pngTile, type RasterLayer } from "../packages/format/src/raster";
const dir = resolve(process.argv[2] ?? "data/raster-relief"),
  template =
    "https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png";
const layer: RasterLayer = {
  id: "relief",
  name: "Europe · Natural Earth relief",
  version: 1,
  kind: "shaded-relief",
  crs: "EPSG:3857",
  matrix: "xyz",
  encoding: "png",
  tileSize: 512,
  minZoom: 0,
  maxZoom: 6,
  bounds: [-15, 32, 35, 65],
  source: {
    url: template,
    attribution: "Natural Earth · imagery delivered by OpenFreeMap",
    license: "Natural Earth public domain",
  },
};
if (await Bun.file(join(dir, "relief.atlas")).exists())
  throw new Error(
    "relief.atlas already exists; use a new directory for a new immutable revision",
  );
const queue: { z: number; x: number; y: number }[] = [],
  nw = project(layer.bounds[0], layer.bounds[3]),
  se = project(layer.bounds[2], layer.bounds[1]);
for (let z = 0; z <= layer.maxZoom; z++) {
  const n = 2 ** z;
  for (let x = Math.floor(nw[0] * n); x <= Math.floor(se[0] * n); x++)
    for (let y = Math.floor(nw[1] * n); y <= Math.floor(se[1] * n); y++)
      queue.push({ z, x, y });
}
let completed = 0,
  bytesRead = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const file = join(dir, "tiles", String(t.z), String(t.x), `${t.y}.png`);
      if (!(await Bun.file(file).exists())) {
        const url = template
          .replace("{z}", String(t.z))
          .replace("{x}", String(t.x))
          .replace("{y}", String(t.y));
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`${r.status}: ${url}`);
        const b = new Uint8Array(await r.arrayBuffer());
        pngTile(b, 512);
        await Bun.write(file, b);
        bytesRead += b.length;
      }
      completed++;
      if (completed % 20 === 0)
        console.log(`${completed} relief tiles retained`);
    }
  }),
);
await Bun.write(join(dir, "layer.json"), JSON.stringify(layer, null, 2));
console.log({
  directory: dir,
  downloadBytes: bytesRead,
  ...(await packRaster(
    join(dir, "tiles"),
    layer,
    join(dir, "relief.atlas"),
    128 * 1024 ** 2,
  )),
});
