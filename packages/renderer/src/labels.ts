import { project } from "../../format/src/index";
import { AtlasReader } from "../../format/src/reader";
import { worldProjector, cameraBounds, type Camera } from "./camera";
import type { MapStyle } from "./style";
import {
  decodeLabels,
  roadMinZoom,
  poiMinZoom,
  poiColor,
  type LabelBlock,
  type RoadLabel,
} from "../../labels/src/index";
import type { Position, Location } from "../../geocoding/src/model";
type Box = [number, number, number, number];
export interface LabelStats {
  places?: number;
  roads: number;
  pois: number;
  loading: number;
  missing: number;
}
export function overlaps(a: Box, b: Box) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}
/** Straight text spans only run where the road is long enough and bends gently. */
export function roadPlacement(
  points: Position[],
  textWidth: number,
  width: number,
  height: number,
  fontScale = 1,
): { x: number; y: number; angle: number; box: Box } | null {
  const visible: Position[][] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    let lo = 0,
      hi = 1;
    for (const [p, q] of [
      [-dx, a[0] - 8],
      [dx, width - 8 - a[0]],
      [-dy, a[1] - 8],
      [dy, height - 8 - a[1]],
    ]) {
      if (p === 0) {
        if (q! < 0) {
          hi = -1;
          break;
        }
      } else {
        const t = q! / p!;
        if (p! < 0) lo = Math.max(lo, t);
        else hi = Math.min(hi, t);
      }
    }
    if (hi <= lo) continue;
    const start: Position = [a[0] + dx * lo, a[1] + dy * lo],
      end: Position = [a[0] + dx * hi, a[1] + dy * hi];
    const prior = visible.at(-1),
      last = prior?.at(-1);
    if (
      prior &&
      last &&
      Math.hypot(last[0] - start[0], last[1] - start[1]) < 0.01
    )
      prior.push(end);
    else visible.push([start, end]);
  }
  const spans = visible
    .map((p) => ({
      p,
      l: p.slice(1).map((v, i) => Math.hypot(v[0] - p[i]![0], v[1] - p[i]![1])),
    }))
    .sort(
      (a, b) => b.l.reduce((n, v) => n + v, 0) - a.l.reduce((n, v) => n + v, 0),
    );
  for (const { p, l } of spans) {
    const total = l.reduce((n, v) => n + v, 0);
    if (total < textWidth + 22) continue;
    const at = (d: number): Position => {
      for (let i = 0; i < l.length; i++) {
        if (d <= l[i]!) {
          const t = l[i]! ? d / l[i]! : 0;
          return [
            p[i]![0] + (p[i + 1]![0] - p[i]![0]) * t,
            p[i]![1] + (p[i + 1]![1] - p[i]![1]) * t,
          ];
        }
        d -= l[i]!;
      }
      return p.at(-1)!;
    };
    const a = at((total - textWidth) / 2),
      b = at((total + textWidth) / 2),
      mid = at(total / 2);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < textWidth * 0.93) continue;
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    const x = (a[0] + b[0]) / 2,
      y = (a[1] + b[1]) / 2;
    if (Math.hypot(mid[0] - x, mid[1] - y) > 4) continue;
    const w =
        (Math.abs(Math.cos(angle)) * textWidth) / 2 +
        Math.abs(Math.sin(angle)) * 7 * fontScale +
        5,
      h =
        (Math.abs(Math.sin(angle)) * textWidth) / 2 +
        Math.abs(Math.cos(angle)) * 7 * fontScale +
        5;
    if (x - w < 5 || y - h < 5 || x + w > width - 5 || y + h > height - 5)
      continue;
    return { x, y, angle, box: [x - w, y - h, x + w, y + h] };
  }
  return null;
}
export class MapLabels {
  roads = true;
  pois = true;
  private dead = false;
  private widths = new Map<string, number>();
  private geometry = new WeakMap<
    RoadLabel,
    { points: Position[]; bounds: Box }
  >();
  private candidates = {
    signature: "",
    roads: [] as RoadLabel[],
    pois: [] as Location[],
  };
  private measure(ctx: CanvasRenderingContext2D, text: string) {
    const key = ctx.font + "|" + text;
    let width = this.widths.get(key);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      if (this.widths.size >= 8192) this.widths.clear();
      this.widths.set(key, width);
    }
    return width;
  }
  private roadGeometry(road: RoadLabel) {
    let geometry = this.geometry.get(road);
    if (!geometry) {
      const points = road.coordinates.map((p) => project(...p));
      let w = Infinity,
        n = Infinity,
        e = -Infinity,
        s = -Infinity;
      for (const [x, y] of points) {
        w = Math.min(w, x);
        n = Math.min(n, y);
        e = Math.max(e, x);
        s = Math.max(s, y);
      }
      geometry = { points, bounds: [w, n, e, s] };
      this.geometry.set(road, geometry);
    }
    return geometry;
  }
  private blocks = new Map<string, LabelBlock>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private wanted: string[] = [];
  private keys: Set<string>;
  private hits: { box: Box; poi: Location }[] = [];
  constructor(
    readonly reader: AtlasReader,
    readonly invalidate: () => void,
    readonly error: (message: string) => void,
  ) {
    if (typeof document !== "undefined")
      document.fonts?.ready.then(() => {
        if (!this.dead) {
          this.widths.clear();
          this.invalidate();
        }
      });
    this.keys = new Set(
      reader.index.blocks
        .filter((b) => b.key.startsWith("labels/"))
        .map((b) => b.key),
    );
  }
  retry() {
    this.failed.clear();
  }
  pick(x: number, y: number) {
    return this.hits.find(
      (h) => x >= h.box[0] && x <= h.box[2] && y >= h.box[1] && y <= h.box[3],
    )?.poi;
  }
  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    style: MapStyle["labels"],
    occupied: Box[],
  ): LabelStats {
    this.hits = [];
    const { zoom, width, height } = camera;
    const stats: LabelStats = { roads: 0, pois: 0, loading: 0, missing: 0 };
    const z = this.reader.index.manifest.labelZoom;
    if (z === undefined || zoom < 13 || (!this.roads && !this.pois)) {
      this.wanted = [];
      return stats;
    }
    const n = 2 ** z,
      [west, north, east, south] = cameraBounds(camera);
    this.wanted = [];
    for (
      let x = Math.max(0, Math.floor(west * n));
      x <= Math.min(n - 1, Math.floor(east * n));
      x++
    )
      for (
        let y = Math.max(0, Math.floor(north * n));
        y <= Math.min(n - 1, Math.floor(south * n));
        y++
      ) {
        const key = `labels/${z}/${x}/${y}`;
        if (this.keys.has(key)) this.wanted.push(key); // Legacy combined labels.
        for (const kind of ["roads", "pois"] as const) {
          if (!this[kind]) continue;
          for (const tier of [13, 14, 15, 16, 17]) {
            const part = `${key}/${kind}/${tier}`;
            if (zoom >= tier && this.keys.has(part)) this.wanted.push(part);
          }
        }
      }
    for (const key of this.wanted) {
      if (
        this.blocks.has(key) ||
        this.pending.has(key) ||
        this.failed.has(key) ||
        this.pending.size >= 4
      )
        continue;
      this.pending.add(key);
      this.reader
        .block(key)
        .then((bytes) => {
          if (!this.dead) this.blocks.set(key, decodeLabels(bytes));
        })
        .catch((e) => {
          if (!this.dead) {
            this.failed.add(key);
            this.error(String(e));
          }
        })
        .finally(() => {
          this.pending.delete(key);
          if (!this.dead) this.invalidate();
        });
    }
    stats.loading = this.pending.size;
    stats.missing = this.wanted.filter((k) => !this.blocks.has(k)).length;
    const toScreen = worldProjector(camera);
    const screen = (p: Position) => toScreen(project(...p));
    const signature = this.wanted
      .map((k) => `${k}:${this.blocks.has(k)}`)
      .join("|");
    if (signature !== this.candidates.signature) {
      const roads: RoadLabel[] = [],
        pois: Location[] = [];
      for (const key of this.wanted) {
        const b = this.blocks.get(key);
        if (b) {
          roads.push(...b.roads);
          pois.push(...b.pois);
        }
      }
      roads.sort(
        (a, b) =>
          roadMinZoom(a.category) - roadMinZoom(b.category) ||
          a.id.localeCompare(b.id),
      );
      pois.sort(
        (a, b) =>
          poiMinZoom(a.category) - poiMinZoom(b.category) ||
          a.id.localeCompare(b.id),
      );
      this.candidates = { signature, roads, pois };
    }
    const { roads, pois } = this.candidates;
    ctx.save();
    ctx.font = `500 ${12 * style.scale}px "Avenir Next", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const named = new Map<string, Position[]>();
    if (this.roads)
      for (const road of roads) {
        if (zoom < roadMinZoom(road.category)) continue;
        const geometry = this.roadGeometry(road),
          bounds = geometry.bounds;
        if (
          bounds[2] < west ||
          bounds[0] > east ||
          bounds[3] < north ||
          bounds[1] > south
        )
          continue;
        const placement = roadPlacement(
          geometry.points.map(toScreen),
          this.measure(ctx, road.name),
          width,
          height,
          style.scale,
        );
        if (!placement) continue;
        const { x, y, angle, box } = placement;
        if (
          occupied.some((b) => overlaps(b, box)) ||
          named
            .get(road.name)
            ?.some((p) => Math.hypot(p[0] - x, p[1] - y) < 280)
        )
          continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.strokeStyle = style.halo;
        ctx.lineWidth = 3;
        ctx.strokeText(road.name, 0, 0);
        ctx.fillStyle = style.color;
        ctx.fillText(road.name, 0, 0);
        ctx.restore();
        occupied.push(box);
        named.set(road.name, [...(named.get(road.name) ?? []), [x, y]]);
        stats.roads++;
      }
    ctx.font = `500 ${11 * style.scale}px "Avenir Next", sans-serif`;
    ctx.textAlign = "left";
    const seen = new Set<string>();
    if (this.pois)
      for (const poi of pois) {
        if (zoom < poiMinZoom(poi.category) || seen.has(poi.id)) continue;
        const [x, y] = screen(poi.coordinates);
        if (x < 6 || y < 6 || x > width - 6 || y > height - 6) continue;
        const text =
            poi.name.length > 45 ? poi.name.slice(0, 42) + "…" : poi.name,
          w = this.measure(ctx, text);
        const box: Box = [
          x - 7,
          y - 9 * style.scale,
          x + w + 16,
          y + 9 * style.scale,
        ];
        if (
          box[0] < 6 ||
          box[1] < 6 ||
          box[2] > width - 6 ||
          box[3] > height - 6 ||
          occupied.some((b) => overlaps(b, box))
        )
          continue;
        // Avoid a node and area label for the same establishment occupying the same place.
        const duplicate = `${poi.name.toLocaleLowerCase()}|${Math.round(x / 55)}|${Math.round(y / 40)}`;
        if (seen.has(duplicate)) continue;
        seen.add(duplicate);
        seen.add(poi.id);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = poiColor(poi.category);
        ctx.fill();
        ctx.strokeStyle = style.halo;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = style.halo;
        ctx.lineWidth = 3;
        ctx.strokeText(text, x + 10, y);
        ctx.fillStyle = style.color;
        ctx.fillText(text, x + 10, y);
        occupied.push(box);
        this.hits.push({ box, poi });
        stats.pois++;
      }
    ctx.restore();
    return stats;
  }
  destroy() {
    this.dead = true;
    this.blocks.clear();
  }
}
