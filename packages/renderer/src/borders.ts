import type { AtlasReader } from "../../format/src/reader";
import {
  BORDER_ROOT,
  BORDER_PAGE_BYTES,
  hasBorderDisplay,
  validateBorderCatalog,
  validateBorderPage,
  visibleBorderPages,
  simplifyBorder,
  type BorderCatalog,
  type BorderPage,
} from "../../boundaries/src/display";
import type { Bounds } from "../../features/src/index";
import { overlaps } from "../../features/src/pages";
import { project, unproject } from "../../format/src/index";
import { worldToScreen, type Camera } from "./camera";
import type { MapStyle } from "./style";

/** Clip display strokes in the same Mercator plane used by the canvas. */
export function clipBorderLines(lines: [number, number][][], box: Bounds) {
  const output: [number, number][][] = [];
  for (const line of lines) {
    let part: [number, number][] = [];
    for (let i = 1; i < line.length; i++) {
      const a = project(...line[i - 1]!),
        b = project(...line[i]!);
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      let lo = 0,
        hi = 1;
      for (const [p, q] of [
        [-dx, a[0] - box[0]],
        [dx, box[2] - a[0]],
        [-dy, a[1] - box[1]],
        [dy, box[3] - a[1]],
      ]) {
        if (p === 0) {
          if (q! < 0) {
            hi = -1;
            break;
          }
        } else if (p! < 0) lo = Math.max(lo, q! / p!);
        else hi = Math.min(hi, q! / p!);
      }
      if (lo >= hi) {
        part = [];
        continue;
      }
      const start = unproject(a[0] + lo * dx, a[1] + lo * dy);
      const end = unproject(a[0] + hi * dx, a[1] + hi * dy);
      const last = part.at(-1);
      if (
        !last ||
        Math.abs(last[0] - start[0]) > 1e-10 ||
        Math.abs(last[1] - start[1]) > 1e-10
      ) {
        part = [start];
        output.push(part);
      }
      part.push(end);
    }
  }
  return output;
}

/** Display reads only: no scan of exact boundary metadata or analysis polygons. */
export class BorderOverlay {
  private catalog?: BorderCatalog;
  private cache = new Map<
    string,
    {
      borders: Array<{ level: number; lines: Float64Array[] }>;
      bytes: number;
    }
  >();
  private wanted = new Map<string, BorderPage>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private opening = false;
  private dead = false;
  private bytes = 0;
  private budget = 24 * 1024 ** 2;
  private detailZoom = -1;
  private window?: Bounds;
  private generation = 0;
  get loading() {
    return this.pending.size + Number(this.opening);
  }
  constructor(
    private reader: AtlasReader,
    private changed: () => void,
    private error: (e: string) => void,
  ) {}
  update(view: Bounds, zoom: number, enabled: boolean) {
    if (this.dead) return;
    if (!enabled || !hasBorderDisplay(this.reader)) {
      this.wanted.clear();
      return;
    }
    if (!this.catalog && !this.opening && !this.failed.has(BORDER_ROOT)) {
      this.opening = true;
      void this.reader
        .block(BORDER_ROOT)
        .then((bytes) => {
          if (bytes.length > 16 * 1024 ** 2)
            throw new Error("Administrative border index exceeds 16 MiB");
          if (!this.dead)
            this.catalog = validateBorderCatalog(
              JSON.parse(new TextDecoder().decode(bytes)),
            );
        })
        .catch((e) => {
          if (!this.dead) {
            this.failed.add(BORDER_ROOT);
            this.error(String(e));
          }
        })
        .finally(() => {
          this.opening = false;
          if (!this.dead) this.changed();
        });
    }
    if (!this.catalog) return;
    // Stored outlines also support close inspection. Keep only screen-scale
    // detail in the live canvas cache; otherwise regional views retain millions
    // of invisible sub-pixel vertices. Rebuild from verified blocks when zooming.
    const detailZoom = Math.ceil(zoom) - 1;
    // A 4K desktop exposes far more geometry than a phone at the same zoom.
    // Keep an explicit bound, scaled to the actual Mercator viewport in pixels.
    const worldPixels = 256 * 2 ** zoom;
    const pixelArea =
      (view[2] - view[0]) * (view[3] - view[1]) * worldPixels ** 2;
    this.budget = Math.min(
      96 * 1024 ** 2,
      Math.max(24 * 1024 ** 2, pixelArea * 32),
    );
    const windowContainsView =
      this.window &&
      this.window[0] <= view[0] &&
      this.window[1] <= view[1] &&
      this.window[2] >= view[2] &&
      this.window[3] >= view[3];
    if (detailZoom !== this.detailZoom || !windowContainsView) {
      this.detailZoom = detailZoom;
      const dx = (view[2] - view[0]) / 4,
        dy = (view[3] - view[1]) / 4;
      this.window = [view[0] - dx, view[1] - dy, view[2] + dx, view[3] + dy];
      this.generation++;
      this.cache.clear();
      this.bytes = 0;
      for (const key of this.failed)
        if (key !== BORDER_ROOT) this.failed.delete(key);
    }
    this.wanted = new Map(
      visibleBorderPages(this.catalog, view, zoom).map((p) => [p.key, p]),
    );
    for (const key of this.wanted.keys()) {
      const entry = this.cache.get(key);
      if (entry) {
        this.cache.delete(key);
        this.cache.set(key, entry);
      }
    }
    this.pump();
  }
  private pump() {
    if (this.dead) return;
    for (const [key, page] of this.wanted) {
      if (this.pending.size >= 2) break;
      if (this.cache.has(key) || this.pending.has(key) || this.failed.has(key))
        continue;
      this.pending.add(key);
      const detailZoom = this.detailZoom;
      const generation = this.generation,
        window = this.window!;
      void this.reader
        .block(key)
        .then((bytes) => {
          if (bytes.length > BORDER_PAGE_BYTES)
            throw new Error("Administrative border page exceeds 1 MiB");
          const stored = validateBorderPage(
            JSON.parse(new TextDecoder().decode(bytes)),
            page,
          );
          if (
            this.dead ||
            !this.wanted.has(key) ||
            generation !== this.generation
          )
            return;
          const nw = unproject(window[0], window[1]),
            se = unproject(window[2], window[3]);
          const bounds: Bounds = [nw[0], se[1], se[0], nw[1]];
          const borders = stored
            .filter((border) => overlaps(border.bbox, bounds))
            .map((border) => ({
              level: border.level,
              lines: clipBorderLines(
                border.lines.flatMap((line) =>
                  simplifyBorder(line, detailZoom),
                ),
                window,
              ).map((line) => {
                // Typed world coordinates avoid one JS array object per vertex
                // and repeated geographic projection on every draw frame.
                const points = new Float64Array(line.length * 2);
                line.forEach((p, i) => points.set(project(...p), i * 2));
                return points;
              }),
            }))
            .filter((border) => border.lines.length > 0);
          // Budget decoded coordinates conservatively; never evict a visible page
          // and refetch it every frame. Report an explicit limit instead.
          const size = borders.reduce(
            (n, border) =>
              n +
              256 +
              border.lines.reduce((m, line) => m + 128 + line.byteLength, 0),
            0,
          );
          for (const [old, entry] of this.cache) {
            if (this.bytes + size <= this.budget) break;
            if (!this.wanted.has(old)) {
              this.cache.delete(old);
              this.bytes -= entry.bytes;
            }
          }
          if (this.bytes + size > this.budget)
            throw new Error(
              "Administrative borders exceed the display memory budget. Zoom in to a smaller area.",
            );
          this.cache.set(key, { borders, bytes: size });
          this.bytes += size;
        })
        .catch((e) => {
          if (!this.dead) {
            this.failed.add(key);
            this.error(String(e));
          }
        })
        .finally(() => {
          this.pending.delete(key);
          if (!this.dead) {
            this.changed();
            this.pump();
          }
        });
    }
  }
  draw(ctx: CanvasRenderingContext2D, camera: Camera, style: MapStyle) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Fine areas first, country outlines above them. Rings are stroked, never filled.
    const borders = [...this.wanted.keys()]
      .flatMap((k) => this.cache.get(k)?.borders ?? [])
      .sort((a, b) => b.level - a.level);
    for (const b of borders) {
      ctx.beginPath();
      for (const line of b.lines)
        for (let i = 0; i < line.length; i += 2) {
          const [x, y] = worldToScreen([line[i]!, line[i + 1]!], camera);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
      const country = b.level <= 2;
      ctx.setLineDash(country ? [] : b.level <= 4 ? [6, 4] : [2, 3]);
      ctx.globalAlpha = country ? 0.9 : 0.65;
      ctx.strokeStyle = style.labels.halo;
      ctx.lineWidth = country ? 3.5 : 2.5;
      ctx.stroke();
      ctx.strokeStyle = style.labels.color;
      ctx.lineWidth = country ? 1.5 : 1;
      ctx.stroke();
    }
    ctx.restore();
  }
  retry() {
    this.failed.clear();
  }
  destroy() {
    this.dead = true;
    this.wanted.clear();
    this.cache.clear();
    this.bytes = 0;
  }
}
