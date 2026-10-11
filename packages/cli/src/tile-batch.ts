import geojsonvt from "geojson-vt";
import type { Feature } from "geojson";
import { project, TILE_EXTENT } from "../../format/src/index";
import { splitTile } from "../../format/src/tiles";
import type { PackageSelection } from "../../provisioning/src/selection";
import { bounds, selectedCell } from "../../offline/src/geometry";
import { encodeTile } from "./tile-codec";
import { displayMinZoom } from "./display";
/** Same tiling and output order for the sequential path and each parallel batch. */
export function renderTileBatch(
  features: Feature[],
  selection: PackageSelection,
  signal: AbortSignal,
  emit: (key: string, bytes: Uint8Array) => void,
) {
  const box = bounds(selection.polygon),
    nw = project(box[0], box[3]),
    se = project(box[2], box[1]);
  for (const overview of [true, false]) {
    const lo = Math.max(selection.minZoom, overview ? 0 : 6),
      hi = Math.min(selection.maxZoom, overview ? 5 : 16);
    if (lo > hi) continue;
    const selected = overview
      ? features.filter((f) => displayMinZoom(f.properties ?? {}) <= 5)
      : features;
    if (!selected.length) continue;
    const index = geojsonvt(
      { type: "FeatureCollection", features: selected },
      {
        maxZoom: selection.maxZoom,
        extent: TILE_EXTENT,
        buffer: 0,
        tolerance: overview ? 5 : TILE_EXTENT / 512,
        indexMaxZoom: 0,
        indexMaxPoints: 100000,
      },
    );
    const internals = index as unknown as {
      tiles: Record<
        number,
        { source: unknown; features: unknown[]; numFeatures: number }
      >;
      tileCoords: unknown[];
    };
    const id = (z: number, x: number, y: number) => (2 ** z * y + x) * 32 + z;
    function walk(z: number, x: number, y: number) {
      signal.throwIfAborted();
      const n = 2 ** z;
      if (
        x < Math.floor(nw[0] * n) ||
        x > Math.min(n - 1, Math.floor(se[0] * n)) ||
        y < Math.floor(nw[1] * n) ||
        y > Math.min(n - 1, Math.floor(se[1] * n))
      ) {
        delete internals.tiles[id(z, x, y)];
        return;
      }
      const tile = index.getTile(z, x, y);
      internals.tileCoords.length = 0;
      if (!tile) return;
      if (z >= lo && selectedCell(selection.polygon, z, x, y)) {
        const visible = tile.features.filter(
          (f) => z >= displayMinZoom(f.tags ?? {}),
        );
        if (visible.length)
          for (const part of splitTile(encodeTile(visible)))
            emit(`tile/${part.layer}/${z}/${x}/${y}`, part.bytes);
      }
      const t = internals.tiles[id(z, x, y)];
      if (z < hi && t?.numFeatures) {
        for (let dx = 0; dx < 2; dx++)
          for (let dy = 0; dy < 2; dy++) walk(z + 1, x * 2 + dx, y * 2 + dy);
      }
      delete internals.tiles[id(z, x, y)];
    }
    walk(0, 0, 0);
  }
}
