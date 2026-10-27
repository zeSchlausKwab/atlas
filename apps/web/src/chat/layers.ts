import type { Feature, FeatureCollection, Position } from "geojson";
import { project } from "../../../../packages/format/src/index";
import { worldProjector } from "../../../../packages/renderer/src/camera";
import type { WorkspaceMap } from "../../../../packages/renderer/src/workspace-map";
import {
  validateDrawing,
  drawingBounds,
} from "../../../../packages/chat/src/geometry";
import {
  featureStyle,
  contrastingInk,
  validateLayerStyle,
  type DrawingStyle,
  type LegendEntry,
} from "../../../../packages/chat/src/drawing-style";
export interface InspectedFeature {
  id?: string | number;
  layer: string;
  result?: string;
  properties: Feature["properties"];
  geometryType: string;
  provenance?: Record<string, unknown>;
}
export interface ChatLayer {
  id: string;
  title: string;
  count: number;
  color: string;
  style: DrawingStyle;
  legend: LegendEntry[];
  result?: string;
  collection: FeatureCollection;
  provenance?: Record<string, unknown>;
  bounds: [number, number, number, number] | null;
}
export class ChatLayers {
  private values: ChatLayer[] = [];
  private remove: () => void;
  private listeners = new Set<() => void>();
  private cachedKey = "";
  private paths: Array<{
    layer: ChatLayer;
    feature: Feature;
    path: Path2D;
    area: boolean;
    point: boolean;
    color: string;
  }> = [];
  private labels: Array<{
    x: number;
    y: number;
    ax: number;
    ay: number;
    text: string;
    color: string;
    size: number;
    badge: boolean;
    radius: number;
    labelColor: string;
  }> = [];
  constructor(readonly map: WorkspaceMap) {
    this.remove = map.overlays.add({
      id: "chat-results",
      order: 48,
      draw: (frame) => {
        const { camera, ctx } = frame;
        const key = JSON.stringify(camera);
        if (key !== this.cachedKey) {
          this.cachedKey = key;
          this.paths = [];
          this.labels = [];
          const occupied = new LabelGrid();
          const screen = worldProjector(camera);
          const xy = (p: Position) => screen(project(p[0]!, p[1]!));
          const line = (
            path: Path2D,
            positions: Position[],
            close = false,
            visit?: (x: number, y: number) => void,
          ) => {
            positions.forEach((p, i) => {
              const [x, y] = xy(p);
              visit?.(x, y);
              if (i) path.lineTo(x, y);
              else path.moveTo(x, y);
            });
            if (close) path.closePath();
          };
          for (const layer of this.values)
            for (const f of layer.collection.features) {
              const visual = featureStyle(f, layer.color, layer.style);
              const path = new Path2D(),
                g = f.geometry;
              const anchors: Array<[number, number]> = [];
              const extent = [Infinity, Infinity, -Infinity, -Infinity];
              const outline = (p: Position[], close = false) => {
                line(
                  path,
                  p,
                  close,
                  visual.label
                    ? (x, y) => {
                        extent[0] = Math.min(extent[0]!, x);
                        extent[1] = Math.min(extent[1]!, y);
                        extent[2] = Math.max(extent[2]!, x);
                        extent[3] = Math.max(extent[3]!, y);
                      }
                    : undefined,
                );
              };
              let area = false,
                point = false;
              const dot = (p: Position) => {
                const [x, y] = xy(p);
                anchors.push([x, y]);
                path.moveTo(x + visual.radius, y);
                path.arc(x, y, visual.radius, 0, Math.PI * 2);
                point = true;
              };
              switch (g.type) {
                case "Point":
                  dot(g.coordinates);
                  break;
                case "MultiPoint":
                  g.coordinates.forEach(dot);
                  break;
                case "LineString":
                  outline(g.coordinates);
                  break;
                case "MultiLineString":
                  g.coordinates.forEach((p) => outline(p));
                  break;
                case "Polygon":
                  area = true;
                  g.coordinates.forEach((p) => outline(p, true));
                  break;
                case "MultiPolygon":
                  area = true;
                  g.coordinates.forEach((p) =>
                    p.forEach((r) => outline(r, true)),
                  );
                  break;
              }
              this.paths.push({
                layer,
                feature: f,
                path,
                area,
                point,
                color: visual.color,
              });
              if (visual.label) {
                if (!anchors.length && Number.isFinite(extent[0]))
                  anchors.push([
                    (extent[0]! + extent[2]!) / 2,
                    (extent[1]! + extent[3]!) / 2,
                  ]);
                const size = layer.style.labelSize ?? 12;
                ctx.font = `600 ${size}px "Avenir Next", sans-serif`;
                const badge = point && layer.style.labelPlacement === "center";
                const radius = Math.max(
                  visual.radius,
                  size * 0.7,
                  ctx.measureText(visual.label).width / 2 + 5,
                );
                const halfWidth = badge
                  ? radius
                  : ctx.measureText(visual.label).width / 2 + 4;
                const halfHeight = badge ? radius : size * 0.65 + 3;
                for (const [ax, ay] of anchors) {
                  if (
                    ax < 0 ||
                    ay < 0 ||
                    ax > camera.width ||
                    ay > camera.height
                  )
                    continue;
                  const baseY =
                    ay - (point && !badge ? visual.radius + halfHeight + 5 : 0);
                  // Nearby tour stops keep their real coordinates; labels may move with leader lines.
                  const place = occupied.place(
                    ax,
                    baseY,
                    halfWidth,
                    halfHeight,
                    camera.width,
                    camera.height,
                  );
                  if (!place) continue; // Dense labels declutter; geometry and legends remain visible.
                  this.labels.push({
                    x: place[0],
                    y: place[1],
                    ax,
                    ay,
                    text: visual.label,
                    color: visual.color,
                    size,
                    badge,
                    radius,
                    labelColor:
                      layer.style.labelColor ??
                      (badge ? contrastingInk(visual.color) : "#263c33"),
                  });
                }
              }
            }
        }
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const { layer, path, area, point, color } of this.paths) {
          ctx.fillStyle = color;
          ctx.strokeStyle = color;
          ctx.lineWidth = layer.style.strokeWidth ?? (area ? 1.5 : 3.5);
          if (area || point) {
            ctx.globalAlpha = layer.style.fillOpacity ?? (point ? 0.9 : 0.27);
            ctx.fill(path, "evenodd");
            ctx.globalAlpha = 1;
          }
          if (ctx.lineWidth > 0 && layer.style.strokeWidth !== 0)
            ctx.stroke(path);
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const l of this.labels) {
          if (
            Math.hypot(l.x - l.ax, l.y - l.ay) > (l.badge ? 2 : l.size + 10)
          ) {
            ctx.beginPath();
            ctx.moveTo(l.ax, l.ay);
            ctx.lineTo(l.x, l.y);
            ctx.strokeStyle = l.color;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          if (l.badge) {
            ctx.beginPath();
            ctx.arc(l.x, l.y, l.radius, 0, Math.PI * 2);
            ctx.fillStyle = l.color;
            ctx.fill();
            ctx.strokeStyle = "#fffdf5";
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          ctx.font = `600 ${l.size}px "Avenir Next", sans-serif`;
          ctx.lineWidth = l.badge ? 2 : 4;
          ctx.strokeStyle = l.badge ? l.color : contrastingInk(l.labelColor);
          ctx.strokeText(l.text, l.x, l.y);
          ctx.fillStyle = l.labelColor;
          ctx.fillText(l.text, l.x, l.y);
        }
      },
    });
  }
  getSnapshot = () => this.values;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private changed() {
    this.cachedKey = "";
    this.map.invalidate();
    for (const fn of this.listeners) fn();
  }
  add(
    fc: FeatureCollection,
    title: string,
    color = "#be5438",
    result?: string,
    style: DrawingStyle = {},
    legend: LegendEntry[] = [],
    provenance?: Record<string, unknown>,
  ) {
    validateDrawing(fc);
    validateLayerStyle(fc, color, style, legend);
    const layer: ChatLayer = {
      id: "layer-" + crypto.randomUUID(),
      title,
      count: fc.features.length,
      color,
      style: structuredClone(style),
      legend: structuredClone(legend),
      result,
      collection: structuredClone(fc),
      provenance: provenance ? structuredClone(provenance) : undefined,
      bounds: drawingBounds(fc),
    };
    this.values = [...this.values, layer];
    this.changed();
    return this.describe(layer);
  }
  private describe(layer: ChatLayer) {
    const { id, title, count, result, bounds, color, style, legend } = layer;
    return {
      layer: id,
      title,
      count,
      result,
      bounds,
      color,
      style,
      legend,
      labels:
        "Screen labels declutter when dense; displaced point labels have leader lines. Polygon/line anchors use screen bounds, not entrances.",
    };
  }
  restyle(
    id: string,
    update: {
      title?: string;
      color?: string;
      style?: DrawingStyle;
      legend?: LegendEntry[];
    },
  ) {
    const old = this.values.find((l) => l.id === id);
    if (!old) throw new Error("Unknown drawing layer");
    const layer = {
      ...old,
      ...update,
      style: { ...old.style, ...update.style },
    };
    validateLayerStyle(
      layer.collection,
      layer.color,
      layer.style,
      layer.legend,
    );
    // Geometry is retained by reference; only small visual settings are replaced.
    layer.style = structuredClone(layer.style);
    layer.legend = structuredClone(layer.legend);
    this.values = this.values.map((l) => (l.id === id ? layer : l));
    this.changed();
    return this.describe(layer);
  }
  inspect(point: [number, number]): InspectedFeature | null {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const [x, y] = worldProjector(this.map.camera)(project(...point));
    for (let i = this.paths.length - 1; i >= 0; i--) {
      const { path, feature, layer, area, point: marker } = this.paths[i]!;
      ctx.lineWidth = Math.max(8, layer.style.strokeWidth ?? 3.5);
      if (
        ((area || marker) && ctx.isPointInPath(path, x, y, "evenodd")) ||
        ctx.isPointInStroke(path, x, y)
      )
        return {
          id: feature.id,
          layer: layer.title,
          result: layer.result,
          properties: feature.properties,
          geometryType: feature.geometry.type,
          provenance: layer.provenance,
        };
    }
    return null;
  }
  undo(id = this.values.at(-1)?.id) {
    if (!id || !this.values.some((v) => v.id === id))
      throw new Error("Drawing layer is absent or already undone");
    this.values = this.values.filter((v) => v.id !== id);
    this.changed();
    return { removed: id };
  }
  fit(id: string) {
    const layer = this.values.find((v) => v.id === id);
    if (!layer) throw new Error("Unknown drawing layer");
    this.fitBounds(layer.bounds);
  }
  fitBounds(b: ChatLayer["bounds"]) {
    if (!b) throw new Error("Result has no geometry to fit");
    const pad = Math.max(b[2] - b[0], b[3] - b[1]) < 0.001 ? 0.001 : 0;
    this.map.fitPositions([
      [b[0] - pad, b[1] - pad],
      [b[2] + pad, b[3] + pad],
    ]);
  }
  clear() {
    this.values = [];
    this.changed();
  }
  destroy() {
    this.remove();
    this.listeners.clear();
    this.map.invalidate();
  }
}

/** Screen-space label collision lookup, independent of the number of source objects. */
class LabelGrid {
  private cells = new Map<string, Array<[number, number, number, number]>>();
  private keys(b: [number, number, number, number]) {
    const out: string[] = [];
    for (let x = Math.floor(b[0] / 64); x <= Math.floor(b[2] / 64); x++)
      for (let y = Math.floor(b[1] / 64); y <= Math.floor(b[3] / 64); y++)
        out.push(`${x}/${y}`);
    return out;
  }
  place(
    x: number,
    y: number,
    w: number,
    h: number,
    width: number,
    height: number,
  ): [number, number] | null {
    if (!Number.isFinite(w + h) || w * 2 > width || h * 2 > height) return null;
    for (const [dx, dy] of [
      [0, 0],
      [0, -2 * h - 5],
      [0, 2 * h + 5],
      [2 * w + 5, 0],
      [-2 * w - 5, 0],
      [2 * w + 5, -2 * h - 5],
      [-2 * w - 5, -2 * h - 5],
    ]) {
      const px = x + dx!,
        py = y + dy!,
        b: [number, number, number, number] = [px - w, py - h, px + w, py + h];
      if (b[0] < 2 || b[1] < 2 || b[2] > width - 2 || b[3] > height - 2)
        continue;
      const keys = this.keys(b);
      if (
        keys.some((k) =>
          this.cells
            .get(k)
            ?.some(
              (a) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
            ),
        )
      )
        continue;
      for (const k of keys) {
        const cell = this.cells.get(k) ?? [];
        cell.push(b);
        this.cells.set(k, cell);
      }
      return [px, py];
    }
    return null;
  }
}
