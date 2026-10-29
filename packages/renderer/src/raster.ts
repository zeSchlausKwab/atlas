import { AtlasReader } from "../../format/src/reader";
import { BudgetCache } from "../../format/src/cache";
import { project } from "../../format/src/index";
import { pngTile, type RasterLayer } from "../../format/src/raster";
import { cameraBounds, worldToScreen, type Camera } from "./camera";
export interface RasterLayerView {
  enabled: boolean;
  opacity: number;
}
export type RasterLayerViews = Record<string, RasterLayerView>;
interface Tile {
  key: string;
  z: number;
  x: number;
  y: number;
  layer: RasterLayer;
}
/** A bounded Canvas image plane between vector geometry and labels. Uses the same orthographic camera. */
export class RasterPlane {
  private surfaces = new Map<string, HTMLCanvasElement>();
  private cache = new BudgetCache<string, ImageBitmap>(
    32 * 1024 ** 2,
    (b) => b.width * b.height * 4,
    (b) => b.close(),
  );
  private pending = new Set<string>();
  private failed = new Set<string>();
  private wanted = new Map<string, Tile>();
  private dead = false;
  constructor(
    private reader: AtlasReader,
    before: HTMLCanvasElement,
    private changed: () => void,
    private error: (e: string) => void,
  ) {
    for (const layer of reader.index.manifest.rasters ?? []) {
      const canvas = document.createElement("canvas");
      canvas.className = "raster-plane";
      canvas.dataset.layer = layer.id;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.mixBlendMode =
        layer.kind === "shaded-relief" ? "multiply" : "normal";
      before.before(canvas);
      this.surfaces.set(layer.id, canvas);
    }
  }
  get stats() {
    return {
      wanted: this.wanted.size,
      tiles: [...this.wanted.keys()].filter((k) => this.cache.has(k)).length,
      loading: this.pending.size,
      missing: [...this.wanted.keys()].filter((k) => this.failed.has(k)).length,
    };
  }
  placeBefore(anchor: HTMLCanvasElement) {
    for (const canvas of this.surfaces.values()) anchor.before(canvas);
  }
  retry() {
    this.failed.clear();
  }
  draw(
    camera: Camera,
    ratio: number,
    opacity = 0.6,
    layers: RasterLayerViews = {},
  ) {
    this.wanted.clear();
    const view = cameraBounds(camera);
    for (const layer of this.reader.index.manifest.rasters ?? []) {
      const canvas = this.surfaces.get(layer.id)!;
      const width = Math.round(camera.width * ratio),
        height = Math.round(camera.height * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, camera.width, camera.height);
      const layerView = layers[layer.id];
      const layerOpacity =
        layerView?.enabled === false ? 0 : (layerView?.opacity ?? opacity);
      if (
        !Number.isFinite(layerOpacity) ||
        layerOpacity <= 0 ||
        camera.zoom < layer.minZoom
      )
        continue;
      const nw = project(layer.bounds[0], layer.bounds[3]),
        se = project(layer.bounds[2], layer.bounds[1]);
      const w = Math.max(view[0], nw[0]),
        n = Math.max(view[1], nw[1]),
        e = Math.min(view[2], se[0]),
        s = Math.min(view[3], se[1]);
      if (w >= e || n >= s) continue;
      const z = Math.max(
          layer.minZoom,
          Math.min(layer.maxZoom, Math.floor(camera.zoom)),
        ),
        scale = 2 ** z;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layerOpacity));
      ctx.beginPath();
      [nw, [se[0], nw[1]], se, [nw[0], se[1]]].forEach((p, i) => {
        const q = worldToScreen(p as [number, number], camera);
        if (i) ctx.lineTo(...q);
        else ctx.moveTo(...q);
      });
      ctx.closePath();
      ctx.clip();
      for (
        let x = Math.max(0, Math.floor(w * scale));
        x <= Math.min(scale - 1, Math.floor(e * scale));
        x++
      )
        for (
          let y = Math.max(0, Math.floor(n * scale));
          y <= Math.min(scale - 1, Math.floor(s * scale));
          y++
        ) {
          const key = `raster/${layer.id}/${z}/${x}/${y}`;
          this.wanted.set(key, { key, z, x, y, layer });
          let image = this.cache.get(key),
            ancestor = z,
            ax = x,
            ay = y;
          while (!image && ancestor > layer.minZoom) {
            ancestor--;
            ax = Math.floor(ax / 2);
            ay = Math.floor(ay / 2);
            image = this.cache.get(
              `raster/${layer.id}/${ancestor}/${ax}/${ay}`,
            );
          }
          if (!image) continue;
          const a = worldToScreen([x / scale, y / scale], camera),
            b = worldToScreen([(x + 1) / scale, y / scale], camera),
            c = worldToScreen([x / scale, (y + 1) / scale], camera);
          ctx.save();
          ctx.transform(
            (b[0] - a[0]) / layer.tileSize,
            (b[1] - a[1]) / layer.tileSize,
            (c[0] - a[0]) / layer.tileSize,
            (c[1] - a[1]) / layer.tileSize,
            a[0],
            a[1],
          );
          const factor = 2 ** (z - ancestor),
            size = layer.tileSize / factor;
          ctx.drawImage(
            image,
            (x - ax * factor) * size,
            (y - ay * factor) * size,
            size,
            size,
            0,
            0,
            layer.tileSize,
            layer.tileSize,
          );
          ctx.restore();
        }
      ctx.restore();
    }
    this.cache.protect(this.wanted.keys());
    this.pump();
  }
  private pump() {
    if (this.dead) return;
    for (const t of this.wanted.values()) {
      if (this.pending.size >= 6) break;
      if (
        this.cache.has(t.key) ||
        this.pending.has(t.key) ||
        this.failed.has(t.key)
      )
        continue;
      this.pending.add(t.key);
      void (async () => {
        const matches = await this.reader.spatial(
          `raster/${t.layer.id}`,
          t.z,
          t.x,
          t.x,
          t.y,
          t.y,
        );
        if (this.dead || !this.wanted.has(t.key)) return;
        if (!matches.length) {
          this.failed.add(t.key);
          return;
        }
        const bytes = await this.reader.block(t.key);
        pngTile(bytes, t.layer.tileSize);
        if (this.dead || !this.wanted.has(t.key)) return;
        const image = await createImageBitmap(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        );
        if (this.dead) {
          image.close();
          return;
        }
        this.cache.set(t.key, image);
      })()
        .catch((e) => {
          if (!this.dead) {
            this.failed.add(t.key);
            this.error(String(e));
          }
        })
        .finally(() => {
          this.pending.delete(t.key);
          if (!this.dead) this.changed();
        });
    }
  }
  destroy() {
    this.dead = true;
    this.wanted.clear();
    this.cache.clear();
    for (const c of this.surfaces.values()) c.remove();
  }
}
