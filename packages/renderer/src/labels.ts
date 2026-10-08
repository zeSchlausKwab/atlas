import { AtlasReader } from "../../format/src/reader";
import { project } from "../../format/src/index";
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
        Math.abs(Math.sin(angle)) * 7 +
        5,
      h =
        (Math.abs(Math.sin(angle)) * textWidth) / 2 +
        Math.abs(Math.cos(angle)) * 7 +
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
    center: Position,
    zoom: number,
    width: number,
    height: number,
    occupied: Box[],
  ): LabelStats {
    this.hits = [];
    const stats: LabelStats = { roads: 0, pois: 0, loading: 0, missing: 0 };
    const z = this.reader.index.manifest.labelZoom;
    if (z === undefined || zoom < 13 || (!this.roads && !this.pois)) {
      this.wanted = [];
      return stats;
    }
    const world = 256 * 2 ** zoom,
      n = 2 ** z,
      dx = width / 2 / world,
      dy = height / 2 / world;
    this.wanted = [];
    for (
      let x = Math.max(0, Math.floor((center[0] - dx) * n));
      x <= Math.min(n - 1, Math.floor((center[0] + dx) * n));
      x++
    )
      for (
        let y = Math.max(0, Math.floor((center[1] - dy) * n));
        y <= Math.min(n - 1, Math.floor((center[1] + dy) * n));
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
      if (this.reader.offline && !this.reader.cache.has(key)) continue;
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
    const screen = (p: Position): Position => {
      const q = project(...p);
      return [
        (q[0] - center[0]) * world + width / 2,
        (q[1] - center[1]) * world + height / 2,
      ];
    };
    const roads: RoadLabel[] = [],
      pois: Location[] = [];
    for (const key of this.wanted) {
      const b = this.blocks.get(key);
      if (b) {
        roads.push(...b.roads);
        pois.push(...b.pois);
      }
    }
    ctx.save();
    ctx.font = '500 12px "Avenir Next", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const named = new Map<string, Position[]>();
    if (this.roads)
      for (const road of roads.sort(
        (a, b) =>
          roadMinZoom(a.category) - roadMinZoom(b.category) ||
          a.id.localeCompare(b.id),
      )) {
        if (zoom < roadMinZoom(road.category)) continue;
        const placement = roadPlacement(
          road.coordinates.map(screen),
          ctx.measureText(road.name).width,
          width,
          height,
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
        ctx.strokeStyle = "#f9f6eb";
        ctx.lineWidth = 3;
        ctx.strokeText(road.name, 0, 0);
        ctx.fillStyle = "#55594c";
        ctx.fillText(road.name, 0, 0);
        ctx.restore();
        occupied.push(box);
        named.set(road.name, [...(named.get(road.name) ?? []), [x, y]]);
        stats.roads++;
      }
    ctx.font = '500 11px "Avenir Next", sans-serif';
    ctx.textAlign = "left";
    const seen = new Set<string>();
    if (this.pois)
      for (const poi of pois.sort(
        (a, b) =>
          poiMinZoom(a.category) - poiMinZoom(b.category) ||
          a.id.localeCompare(b.id),
      )) {
        if (zoom < poiMinZoom(poi.category) || seen.has(poi.id)) continue;
        const [x, y] = screen(poi.coordinates),
          text = poi.name.length > 45 ? poi.name.slice(0, 42) + "…" : poi.name,
          w = ctx.measureText(text).width;
        const box: Box = [x - 7, y - 9, x + w + 16, y + 9];
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
        ctx.strokeStyle = "#fffaf0";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = "#fffaf0";
        ctx.lineWidth = 3;
        ctx.strokeText(text, x + 10, y);
        ctx.fillStyle = poiColor(poi.category);
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
