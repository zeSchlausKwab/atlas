import type { FeatureCollection, Position } from "geojson";
import { project } from "../../../../packages/format/src/index";
import { worldProjector } from "../../../../packages/renderer/src/camera";
import type { WorkspaceMap } from "../../../../packages/renderer/src/workspace-map";
import {
  validateDrawing,
  drawingBounds,
} from "../../../../packages/chat/src/geometry";
export interface ChatLayer {
  id: string;
  title: string;
  count: number;
  color: string;
  result?: string;
  collection: FeatureCollection;
  bounds: [number, number, number, number] | null;
}
export class ChatLayers {
  private values: ChatLayer[] = [];
  private remove: () => void;
  private listeners = new Set<() => void>();
  private cachedKey = "";
  private paths: Array<{
    layer: ChatLayer;
    path: Path2D;
    area: boolean;
    point: boolean;
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
          const screen = worldProjector(camera);
          const xy = (p: Position) => screen(project(p[0]!, p[1]!));
          const line = (path: Path2D, positions: Position[], close = false) => {
            positions.forEach((p, i) => {
              const [x, y] = xy(p);
              if (i) path.lineTo(x, y);
              else path.moveTo(x, y);
            });
            if (close) path.closePath();
          };
          for (const layer of this.values)
            for (const f of layer.collection.features) {
              const path = new Path2D(),
                g = f.geometry;
              let area = false,
                point = false;
              const dot = (p: Position) => {
                const [x, y] = xy(p);
                path.moveTo(x + 5, y);
                path.arc(x, y, 5, 0, Math.PI * 2);
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
                  line(path, g.coordinates);
                  break;
                case "MultiLineString":
                  g.coordinates.forEach((p) => line(path, p));
                  break;
                case "Polygon":
                  area = true;
                  g.coordinates.forEach((p) => line(path, p, true));
                  break;
                case "MultiPolygon":
                  area = true;
                  g.coordinates.forEach((p) =>
                    p.forEach((r) => line(path, r, true)),
                  );
                  break;
              }
              this.paths.push({ layer, path, area, point });
            }
        }
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const { layer, path, area, point } of this.paths) {
          ctx.fillStyle = layer.color + (point ? "dd" : "45");
          ctx.strokeStyle = layer.color;
          ctx.lineWidth = area ? 1.5 : 3.5;
          if (area || point) ctx.fill(path, "evenodd");
          ctx.stroke(path);
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
  ) {
    validateDrawing(fc);
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw new Error("Use a six-digit hex color");
    const layer: ChatLayer = {
      id: "layer-" + crypto.randomUUID(),
      title,
      count: fc.features.length,
      color,
      result,
      collection: structuredClone(fc),
      bounds: drawingBounds(fc),
    };
    this.values = [...this.values, layer];
    this.changed();
    return {
      layer: layer.id,
      title,
      count: layer.count,
      result,
      bounds: layer.bounds,
    };
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
