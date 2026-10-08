import type { Geometry, Position } from "geojson";
import type { MapFeature } from "../../features/src/index";
import { project } from "../../format/src/index";
/** Canvas overlay preserves the complete source shapes; map and polygon holes share even-odd hit testing. */
export class FeatureOverlay {
  features: MapFeature[] = [];
  selected = new Set<string>();
  private hits: { feature: MapFeature; path: Path2D; area: boolean }[] = [];
  draw(
    ctx: CanvasRenderingContext2D,
    center: [number, number],
    zoom: number,
    width: number,
    height: number,
  ) {
    const scale = 256 * 2 ** zoom;
    const screen = (v: Position) => {
      const p = project(v[0]!, v[1]!);
      return [
        (p[0] - center[0]) * scale + width / 2,
        (p[1] - center[1]) * scale + height / 2,
      ];
    };
    this.hits = [];
    ctx.save();
    for (const f of [
      ...this.features.filter((f) => !this.selected.has(f.id)),
      ...this.features.filter((f) => this.selected.has(f.id)),
    ]) {
      const path = new Path2D(),
        area =
          f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon";
      const line = (v: Position[], closed = false) => {
        v.forEach((p, i) => {
          const [x, y] = screen(p);
          if (i === 0) path.moveTo(x!, y!);
          else path.lineTo(x!, y!);
        });
        if (closed) path.closePath();
      };
      const geometry = (g: Geometry): void => {
        switch (g.type) {
          case "LineString":
            line(g.coordinates);
            break;
          case "MultiLineString":
            g.coordinates.forEach((v) => line(v));
            break;
          case "Polygon":
            g.coordinates.forEach((v) => line(v, true));
            break;
          case "MultiPolygon":
            g.coordinates.forEach((p) => p.forEach((v) => line(v, true)));
            break;
        }
      };
      geometry(f.geometry);
      const selected = this.selected.has(f.id);
      ctx.fillStyle = selected ? "#da633d40" : "#327f991c";
      ctx.strokeStyle = selected ? "#bd4d2c" : "#327f99";
      ctx.lineWidth = selected ? 3 : 1.5;
      if (area) ctx.fill(path, "evenodd");
      ctx.stroke(path);
      this.hits.push({ feature: f, path, area });
    }
    ctx.restore();
  }
  pick(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 9;
    let id: string | undefined;
    for (const h of [...this.hits].reverse())
      if (
        (h.area && ctx.isPointInPath(h.path, x, y, "evenodd")) ||
        ctx.isPointInStroke(h.path, x, y)
      ) {
        id = h.feature.id;
        break;
      }
    ctx.restore();
    return id;
  }
}
