import { tileLayer, type MapLayer } from "../../format/src/index";
export interface RenderTile {
  key: string;
  z?: number;
  x?: number;
  y?: number;
}
export interface TileView {
  zoom: number;
  bounds: readonly [number, number, number, number]; // West, north, east, south in normalized Mercator.
  layers: readonly MapLayer[];
  blocks: RenderTile[];
  complete: boolean;
}
/** Chooses drawable coverage separately from the desired download set. */
export class TilePresentation {
  private shown: RenderTile[] = [];
  select(view: TileView, resident: ReadonlySet<string>): RenderTile[] {
    const visible = (b: RenderTile) => {
      const layer = tileLayer(b.key),
        n = 2 ** b.z!;
      return (
        view.layers.length > 0 &&
        (!layer || view.layers.includes(layer)) &&
        b.x! / n < view.bounds[2] &&
        (b.x! + 1) / n > view.bounds[0] &&
        b.y! / n < view.bounds[3] &&
        (b.y! + 1) / n > view.bounds[1]
      );
    };
    const target = view.blocks.filter(visible);
    const previous = this.shown.filter(
      (b) => visible(b) && resident.has(b.key),
    );
    if (view.complete && target.every((b) => resident.has(b.key))) {
      // Known-empty coverage is also ready: don't retain buildings below their minimum zoom.
      this.shown = target;
    } else if (previous.some((b) => b.z !== view.zoom)) {
      // Keep one consistent detail level while the new catalog/meshes are incomplete.
      // Drawing both would double roads and let low-detail fills cover new geometry.
      this.shown = previous;
    } else {
      // First load and same-level panning can fill uncovered ground progressively.
      this.shown = [
        ...new Map(
          [...previous, ...target.filter((b) => resident.has(b.key))].map(
            (b) => [b.key, b],
          ),
        ).values(),
      ];
    }
    return this.shown;
  }
}
