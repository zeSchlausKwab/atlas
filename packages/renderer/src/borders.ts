import type { AtlasReader } from "../../format/src/reader";
import {
  BORDER_ROOT,
  BORDER_PAGE_BYTES,
  hasBorderDisplay,
  validateBorderCatalog,
  validateBorderPage,
  visibleBorderPages,
  type Border,
  type BorderCatalog,
  type BorderPage,
} from "../../boundaries/src/display";
import type { Bounds } from "../../features/src/index";
import { projectScreen, type Camera } from "./camera";
import type { MapStyle } from "./style";

/** Display reads only: no scan of exact boundary metadata or analysis polygons. */
export class BorderOverlay {
  private catalog?: BorderCatalog;
  private cache = new Map<string, { borders: Border[]; bytes: number }>();
  private wanted = new Map<string, BorderPage>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private opening = false;
  private dead = false;
  private bytes = 0;
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
      void this.reader
        .block(key)
        .then((bytes) => {
          if (bytes.length > BORDER_PAGE_BYTES)
            throw new Error("Administrative border page exceeds 1 MiB");
          const borders = validateBorderPage(
            JSON.parse(new TextDecoder().decode(bytes)),
            page,
          );
          if (this.dead || !this.wanted.has(key)) return;
          // Budget decoded coordinates conservatively; never evict a visible page
          // and refetch it every frame. Report an explicit limit instead.
          const size = bytes.length * 3;
          for (const [old, entry] of this.cache) {
            if (this.bytes + size <= 24 * 1024 ** 2) break;
            if (!this.wanted.has(old)) {
              this.cache.delete(old);
              this.bytes -= entry.bytes;
            }
          }
          if (this.bytes + size > 24 * 1024 ** 2)
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
        line.forEach((p, i) => {
          const [x, y] = projectScreen(p, camera);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
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
