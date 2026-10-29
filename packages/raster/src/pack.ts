import { readdir, link, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { StreamWriter } from "../../cli/src/stream-writer";
import { sha256, type Manifest } from "../../format/src/index";
import {
  validateRasters,
  pngTile,
  type RasterLayer,
} from "../../format/src/raster";
/** Import a local XYZ PNG pyramid; no external tile service remains necessary. */
export async function packRaster(
  directory: string,
  layer: RasterLayer,
  output: string,
  maxBytes = 1024 ** 3,
  signal = new AbortController().signal,
  progress: (tiles: number) => void = () => {},
) {
  validateRasters([layer]);
  if (await Bun.file(output).exists()) throw new Error("Output already exists");
  const lock = await open(output + ".lock", "wx"),
    staging = output + ".raster.part";
  let writer: StreamWriter | undefined;
  try {
    writer = await new StreamWriter(staging, maxBytes).open();
    const identities: string[] = [];
    for (let z = layer.minZoom; z <= layer.maxZoom; z++) {
      for (const x of (
        await readdir(join(directory, String(z))).catch(() => [])
      ).sort()) {
        if (!/^(0|[1-9]\d*)$/.test(x) || +x >= 2 ** z) continue;
        for (const file of (
          await readdir(join(directory, String(z), x))
        ).sort()) {
          if (!/^(0|[1-9]\d*)\.png$/.test(file)) continue;
          const y = Number(file.slice(0, -4));
          if (y >= 2 ** z) throw new Error("Invalid XYZ tile");
          signal.throwIfAborted();
          const bytes = new Uint8Array(
            await Bun.file(join(directory, String(z), x, file)).arrayBuffer(),
          );
          pngTile(bytes, layer.tileSize);
          const key = `raster/${layer.id}/${z}/${x}/${y}`,
            hash = await sha256(bytes);
          identities.push(`${key}:${hash}`);
          await writer.add({ key, bytes, features: 0 }, { compress: false });
          progress(identities.length);
        }
      }
    }
    if (!identities.length) throw new Error("No PNG tiles in this XYZ pyramid");
    const manifest: Omit<Manifest, "snapshot"> = {
      format: "atlas",
      version: 1,
      name: layer.name,
      bounds: layer.bounds,
      minZoom: layer.minZoom,
      maxZoom: layer.maxZoom,
      features: 0,
      peaks: 0,
      places: [],
      tileLayers: [],
      rasters: [layer],
      capabilities: ["raster-rendering"],
      source: {
        url: layer.source.url,
        attribution: layer.source.attribution,
        sha256: await sha256(new TextEncoder().encode(identities.join("\n"))),
      },
      limitations: [
        "Visual raster imagery only; pixel values are not elevation measurements.",
        "Coverage is the retained XYZ pyramid; missing tiles are reported, never synthesized from another provider.",
      ],
    };
    const size = await writer.finish(manifest);
    signal.throwIfAborted();
    await link(staging, output);
    return { size, tiles: identities.length };
  } catch (e) {
    await writer?.abort();
    throw e;
  } finally {
    await rm(staging, { force: true });
    await lock.close();
    await rm(output + ".lock", { force: true });
  }
}
