import { PNG } from "pngjs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../format/src/index";
import { pngTile } from "../../format/src/raster";
import type { PreparationProgress } from "../../provisioning/src/selection";
import { NO_SIZE_LIMIT } from "../../provisioning/src/capacity";
import {
  imageDimensions,
  imageTiles,
  projectedImage,
  type ImageImport,
} from "./image-plan";
import { packRaster } from "./pack";

type Pixels = { width: number; height: number; data: Uint8Array };
/** Premultiplied-alpha area overviews prevent dark halos around transparent artwork. */
function overview(source: Pixels): Pixels {
  const width = Math.ceil(source.width / 2),
    height = Math.ceil(source.height / 2),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let j = y * 2; j < Math.min(y * 2 + 2, source.height); j++)
        for (let i = x * 2; i < Math.min(x * 2 + 2, source.width); i++) {
          const k = (j * source.width + i) * 4,
            a = source.data[k + 3]!;
          for (let c = 0; c < 3; c++) sums[c]! += source.data[k + c]! * a;
          sums[3]! += a;
          count++;
        }
      const k = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        data[k + c] = sums[3] ? Math.round(sums[c]! / sums[3]!) : 0;
      data[k + 3] = Math.round(sums[3]! / count);
    }
  return { width, height, data };
}
function sample(p: Pixels, x: number, y: number, out: Buffer, at: number) {
  const left = Math.floor(x),
    top = Math.floor(y),
    fx = x - left,
    fy = y - top;
  let a = 0,
    r = 0,
    g = 0,
    b = 0;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const k =
        (Math.max(0, Math.min(p.height - 1, top + j)) * p.width +
          Math.max(0, Math.min(p.width - 1, left + i))) *
        4;
      const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * p.data[k + 3]!;
      a += weight;
      r += p.data[k]! * weight;
      g += p.data[k + 1]! * weight;
      b += p.data[k + 2]! * weight;
    }
  if (a) {
    out[at] = Math.round(r / a);
    out[at + 1] = Math.round(g / a);
    out[at + 2] = Math.round(b / a);
    out[at + 3] = Math.round(a);
  }
}
/** Work directory contains the pinned input and atomically completed tiles; resumes reuse them. */
export async function importImage(
  plan: ImageImport,
  work: string,
  output: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void = () => {},
) {
  const started = performance.now();
  const input = new Uint8Array(
    await Bun.file(join(work, "input.png")).arrayBuffer(),
  );
  imageDimensions(input);
  if ((await sha256(input)) !== plan.sha256)
    throw new Error("Uploaded image changed since it was queued");
  signal.throwIfAborted();
  const decoded = PNG.sync.read(Buffer.from(input), { checkCRC: true });
  if (decoded.width !== plan.width || decoded.height !== plan.height)
    throw new Error("Image dimensions changed");
  const levels: Pixels[] = [decoded];
  while (levels.at(-1)!.width > 1 || levels.at(-1)!.height > 1) {
    signal.throwIfAborted();
    levels.push(overview(levels.at(-1)!));
    await Bun.sleep(0);
  }
  const tiles = imageTiles(plan.layer),
    [w, n, e, s] = projectedImage(plan.layer.bounds),
    directory = join(work, "tiles");
  let completed = 0,
    written = 0,
    reused = 0;
  for (const { z, x, y } of tiles) {
    signal.throwIfAborted();
    const path = join(directory, `${z}/${x}/${y}.png`);
    if (await Bun.file(path).exists()) {
      pngTile(new Uint8Array(await Bun.file(path).arrayBuffer()), 256);
      written += Bun.file(path).size;
      reused++;
    } else {
      const scale = 2 ** z * 256,
        ratio = Math.max(
          plan.width / ((e - w) * scale),
          plan.height / ((s - n) * scale),
        ),
        level =
          levels[
            Math.max(
              0,
              Math.min(
                levels.length - 1,
                Math.floor(Math.log2(Math.max(1, ratio))),
              ),
            )
          ]!,
        data = Buffer.alloc(256 * 256 * 4);
      for (let py = 0; py < 256; py++) {
        const v = ((y * 256 + py + 0.5) / scale - n) / (s - n);
        if (v < 0 || v >= 1) continue;
        for (let px = 0; px < 256; px++) {
          const u = ((x * 256 + px + 0.5) / scale - w) / (e - w);
          if (u >= 0 && u < 1)
            sample(
              level,
              u * level.width - 0.5,
              v * level.height - 0.5,
              data,
              (py * 256 + px) * 4,
            );
        }
      }
      const png = PNG.sync.write(
        Object.assign(new PNG({ width: 256, height: 256 }), { data }),
        { deflateLevel: 6 },
      );
      await mkdir(join(directory, `${z}/${x}`), { recursive: true });
      await Bun.write(path + ".tmp", png);
      await rename(path + ".tmp", path);
      written += png.length;
    }
    completed++;
    const seconds = (performance.now() - started) / 1000;
    report({
      phase: "compiling",
      stage: "image-tiles",
      message: `Building image tiles · ${completed} / ${tiles.length}${reused ? ` · ${reused} reused` : ""}`,
      completed,
      total: tiles.length,
      unit: "blocks",
      readBytes: input.length,
      writtenBytes: written,
      elapsedSeconds: seconds,
      etaSeconds: (seconds / completed) * (tiles.length - completed),
    });
    await Bun.sleep(0);
  }
  report({
    phase: "packing",
    message: "Packing self-contained imagery archive",
    completed: 0,
    total: tiles.length,
    unit: "blocks",
    readBytes: input.length,
    writtenBytes: written,
  });
  return packRaster(
    directory,
    plan.layer,
    output,
    NO_SIZE_LIMIT,
    signal,
    (count) =>
      report({
        phase: "packing",
        message: `Packing image tiles · ${count} / ${tiles.length}`,
        completed: count,
        total: tiles.length,
        unit: "blocks",
        readBytes: input.length,
        writtenBytes: written,
      }),
  );
}
