import {
  project,
  unproject,
  type Peak,
  type Place,
} from "../../format/src/index";
import type {
  Position,
  WalkingResult,
  Reachable,
} from "../../routing/src/index";
import type { MapStyle } from "./style";
import { worldProjector, worldToScreen, type Camera } from "./camera";
import type { MapLabels, LabelStats } from "./labels";
import type { FeatureOverlay } from "./features";
import type { TileView } from "./tile-presentation";
export interface OverlayFrame {
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  style: MapStyle;
  view: TileView;
  resident: (key: string) => boolean;
  labels: MapLabels;
  features: FeatureOverlay;
  places: Place[];
  placesLoading: boolean;
  placesMissing: boolean;
  state: {
    routingCells: Array<{ key: string; state: string }>;
    reachable: Reachable | null;
    selection: { points: Position[]; closed: boolean } | null;
    grid: boolean;
    route: Extract<WalkingResult, { status: "found" }> | null;
    endpoints: [Position | null, Position | null];
    location: {
      coordinates: Position;
      name: string;
      street?: Position[];
      requested?: Position;
    } | null;
    selected: Peak | null;
  };
  labelStats: LabelStats;
}
export interface MapOverlay {
  id: string;
  order: number;
  draw(frame: OverlayFrame): void;
  dispose?(): void;
}
/** Stable ordered drawing with canvas isolation and explicit replacement/disposal. */
export class OverlayRegistry {
  private layers: MapOverlay[] = [];
  add(layer: MapOverlay) {
    this.remove(layer.id);
    this.layers.push(layer);
    this.layers.sort((a, b) => a.order - b.order);
    return () => {
      if (this.layers.includes(layer)) this.remove(layer.id);
    };
  }
  remove(id: string) {
    const layer = this.layers.find((l) => l.id === id);
    this.layers = this.layers.filter((l) => l.id !== id);
    layer?.dispose?.();
  }
  draw(frame: OverlayFrame) {
    for (const layer of this.layers) {
      frame.ctx.save();
      try {
        layer.draw(frame);
      } finally {
        frame.ctx.restore();
      }
    }
  }
  destroy() {
    for (const layer of this.layers) layer.dispose?.();
    this.layers = [];
  }
}
export function defaultOverlays() {
  const registry = new OverlayRegistry();
  registry.add({
    id: "routing-cells",
    order: 0,
    draw: (frame) => {
      const { ctx, camera, state } = frame;
      const { width, height } = camera;
      for (const c of state.routingCells) {
        const parts = c.key.split("/").slice(-3),
          z = Number(parts[0]),
          x = Number(parts[1]),
          y = Number(parts[2]),
          n = 2 ** z;
        const corners = [
          [x / n, y / n],
          [(x + 1) / n, y / n],
          [(x + 1) / n, (y + 1) / n],
          [x / n, (y + 1) / n],
        ].map((p) => worldToScreen(p as [number, number], camera));
        if (
          corners.every((p) => p[0] < 0) ||
          corners.every((p) => p[0] > width) ||
          corners.every((p) => p[1] < 0) ||
          corners.every((p) => p[1] > height)
        )
          continue;
        const color =
          (
            {
              cached: "#397657",
              loaded: "#397ea2",
              loading: "#bb842f",
              missing: "#c34d40",
            } as Record<string, string>
          )[c.state] ?? "#397657";
        ctx.beginPath();
        corners.forEach(([x, y], i) =>
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
        );
        ctx.closePath();
        ctx.fillStyle = color + "16";
        ctx.fill();
        ctx.strokeStyle = color + "b0";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    },
  });
  registry.add({
    id: "reachability",
    order: 10,
    draw: (frame) => {
      const { ctx, camera, state } = frame;
      const toScreen = worldProjector(camera);
      const screen = (lon: number, lat: number) => toScreen(project(lon, lat));
      if (state.reachable) {
        const colors = ["#22776f", "#578fac", "#c89949", "#a479ae"];
        for (
          let i = state.reachable.contours.features.length - 1;
          i >= 0;
          i--
        ) {
          const feature = state.reachable.contours.features[i]!;
          ctx.beginPath();
          for (const polygon of feature.geometry.coordinates)
            for (const ring of polygon) {
              ring.forEach((p, j) => {
                const [x, y] = screen(p[0]!, p[1]!);
                if (j) ctx.lineTo(x, y);
                else ctx.moveTo(x, y);
              });
              ctx.closePath();
            }
          ctx.fillStyle = colors[i] + "35";
          ctx.fill("evenodd");
          ctx.strokeStyle = colors[i]!;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        const [x, y] = screen(...state.reachable.start.coordinates);
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#22776f";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    },
  });
  registry.add({
    id: "selection",
    order: 20,
    draw: (frame) => {
      const { ctx, camera, state } = frame;
      const toScreen = worldProjector(camera);
      const screen = (lon: number, lat: number) => toScreen(project(lon, lat));
      if (state.selection?.points.length) {
        ctx.beginPath();
        state.selection.points.forEach((p, i) => {
          const [x, y] = screen(...p);
          if (i === 0) ctx.moveTo(x!, y!);
          else ctx.lineTo(x!, y!);
        });
        if (state.selection.closed) ctx.closePath();
        ctx.fillStyle = "#507b4325";
        ctx.fill();
        ctx.strokeStyle = "#345d48";
        ctx.lineWidth = 2.5;
        ctx.setLineDash(state.selection.closed ? [] : [6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const p of state.selection.points) {
          const [x, y] = screen(...p);
          ctx.beginPath();
          ctx.arc(x!, y!, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#fbfaf5";
          ctx.fill();
          ctx.stroke();
        }
      }
    },
  });
  registry.add({
    id: "tile-grid",
    order: 30,
    draw: (frame) => {
      const { ctx, camera, style, state, view } = frame;
      if (state.grid) {
        ctx.lineWidth = 1;
        ctx.font = "10px monospace";
        for (const b of view.blocks) {
          const n = 2 ** b.z!;
          const corners = [
            [b.x! / n, b.y! / n],
            [(b.x! + 1) / n, b.y! / n],
            [(b.x! + 1) / n, (b.y! + 1) / n],
            [b.x! / n, (b.y! + 1) / n],
          ].map((p) => worldToScreen(p as [number, number], camera));
          ctx.strokeStyle = frame.resident(b.key) ? "#65897688" : "#c65b47";
          ctx.beginPath();
          corners.forEach(([x, y], i) =>
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
          );
          ctx.closePath();
          ctx.stroke();
          ctx.fillStyle = style.labels.color;
          ctx.fillText(
            `${b.z}/${b.x}/${b.y}`,
            corners[0]![0] + 6,
            corners[0]![1] + 15,
          );
        }
      }
    },
  });
  registry.add({
    id: "labels",
    order: 40,
    draw: (frame) => {
      const { ctx, camera, style } = frame;
      const { width, height } = camera;
      const toScreen = worldProjector(camera);
      const screen = (lon: number, lat: number) => toScreen(project(lon, lat));
      ctx.font = `500 ${12 * style.labels.scale}px "Avenir Next", sans-serif`;
      ctx.textAlign = "center";
      frame.features.draw(ctx, camera);
      const occupied: Array<[number, number]> = [];
      for (const place of frame.places) {
        const [x, y] = screen(...place.coordinates);
        if (
          x! < 25 ||
          y! < 25 ||
          x! > width - 25 ||
          y! > height - 25 ||
          occupied.some(
            ([a, b]) =>
              Math.abs(a - x!) < 85 * style.labels.scale &&
              Math.abs(b - y!) < 23 * style.labels.scale,
          )
        )
          continue;
        occupied.push([x!, y!]);
        ctx.strokeStyle = style.labels.halo;
        ctx.lineWidth = 3;
        ctx.strokeText(place.name, x!, y!);
        ctx.fillStyle = style.labels.color;
        ctx.fillText(place.name, x!, y!);
      }
      frame.labelStats = frame.labels.draw(
        ctx,
        camera,
        style.labels,
        occupied.map(([x, y]) => [
          x - 44 * style.labels.scale,
          y - 12 * style.labels.scale,
          x + 44 * style.labels.scale,
          y + 5 * style.labels.scale,
        ]),
      );
      frame.labelStats.places = occupied.length;
      frame.labelStats.loading += frame.placesLoading ? 1 : 0;
      frame.labelStats.missing += frame.placesMissing ? 1 : 0;
    },
  });
  registry.add({
    id: "route",
    order: 50,
    draw: (frame) => {
      const { ctx, camera, state } = frame;
      const toScreen = worldProjector(camera);
      const screen = (lon: number, lat: number) => toScreen(project(lon, lat));
      if (state.route) {
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        state.route.coordinates.forEach((p, i) => {
          const [x, y] = screen(...p);
          if (i === 0) ctx.moveTo(x!, y!);
          else ctx.lineTo(x!, y!);
        });
        ctx.strokeStyle = "#fff8e9";
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.strokeStyle = "#be5438";
        ctx.lineWidth = 4;
        ctx.stroke();
        // Dotted offsets show snapping, not a claimed walkable connection.
        [state.route.start.coordinates, state.route.end.coordinates].forEach(
          (p, i) => {
            const request = state.endpoints[i];
            if (!request) return;
            const [x, y] = screen(...request),
              [sx, sy] = screen(...p);
            ctx.beginPath();
            ctx.moveTo(x!, y!);
            ctx.lineTo(sx!, sy!);
            ctx.strokeStyle = "#be5438";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          },
        );
      }
      state.endpoints.forEach((p, i) => {
        if (!p) return;
        const [x, y] = screen(...p);
        ctx.beginPath();
        ctx.arc(x!, y!, 13, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#345d48" : "#be5438";
        ctx.fill();
        ctx.strokeStyle = "#fff8e9";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff8e9";
        ctx.font = 'bold 12px "Avenir Next", sans-serif';
        ctx.fillText(i === 0 ? "A" : "B", x!, y!);
        ctx.textBaseline = "alphabetic";
      });
    },
  });
  registry.add({
    id: "location",
    order: 60,
    draw: (frame) => {
      const { ctx, camera, state } = frame;
      const toScreen = worldProjector(camera);
      const screen = (lon: number, lat: number) => toScreen(project(lon, lat));
      if (state.location) {
        const selected = state.location;
        if (selected.street) {
          ctx.beginPath();
          selected.street.forEach((p, i) => {
            const [x, y] = screen(...p);
            if (i === 0) ctx.moveTo(x!, y!);
            else ctx.lineTo(x!, y!);
          });
          ctx.strokeStyle = "#fff9e9";
          ctx.lineWidth = 8;
          ctx.stroke();
          ctx.strokeStyle = "#39708a";
          ctx.lineWidth = 4;
          ctx.stroke();
        }
        const [x, y] = screen(...selected.coordinates);
        if (selected.requested) {
          const [rx, ry] = screen(...selected.requested);
          ctx.beginPath();
          ctx.moveTo(rx!, ry!);
          ctx.lineTo(x!, y!);
          ctx.setLineDash([3, 4]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#39708a";
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(rx!, ry!, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#fff9e9";
          ctx.fill();
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x!, y!, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#39708a";
        ctx.fill();
        ctx.strokeStyle = "#fff9e9";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.font = '600 12px "Avenir Next", sans-serif';
        ctx.textAlign = "center";
        ctx.strokeText(selected.name, x!, y! - 17);
        ctx.fillStyle = "#254e63";
        ctx.fillText(selected.name, x!, y! - 17);
      }
    },
  });
  registry.add({
    id: "peak",
    order: 70,
    draw: (frame) => {
      const { ctx, camera, state } = frame;
      const toScreen = worldProjector(camera);
      const screen = (lon: number, lat: number) => toScreen(project(lon, lat));
      if (state.selected) {
        const [x, y] = screen(...state.selected.coordinates);
        ctx.beginPath();
        ctx.arc(x!, y!, 12, 0, Math.PI * 2);
        ctx.fillStyle = "#d15b37";
        ctx.fill();
        ctx.strokeStyle = "#fff8e9";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.font = '600 13px "Avenir Next", sans-serif';
        ctx.textAlign = "center";
        ctx.strokeText(state.selected.name, x!, y! - 23);
        ctx.fillStyle = "#693923";
        ctx.fillText(state.selected.name, x!, y! - 23);
      }
    },
  });
  registry.add({
    id: "scale",
    order: 80,
    draw: (frame) => {
      const { ctx, camera, style } = frame;
      const { height } = camera;
      const world = 256 * 2 ** camera.zoom;
      const [, lat] = unproject(...camera.center);
      const metersPerPixel =
        (Math.cos((lat * Math.PI) / 180) * 40075016.686) / world;
      const ideal = 110 * metersPerPixel;
      const base = 10 ** Math.floor(Math.log10(ideal));
      const distance =
        [1, 2, 5, 10]
          .map((n) => n * base)
          .filter((n) => n <= ideal)
          .pop() ?? base;
      const pixels = distance / metersPerPixel;
      ctx.strokeStyle = style.labels.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(24, height - 39);
      ctx.lineTo(24, height - 34);
      ctx.lineTo(24 + pixels, height - 34);
      ctx.lineTo(24 + pixels, height - 39);
      ctx.stroke();
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = style.labels.color;
      ctx.fillText(
        distance >= 1000 ? `${distance / 1000} km` : `${distance} m`,
        24,
        height - 44,
      );
    },
  });
  return registry;
}
