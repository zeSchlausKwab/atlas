import type { TileView } from "./tile-presentation";
export interface CachedTile {
  z: number;
  x: number;
  y: number;
  total: number;
  cached: number;
  /** null means the directory is not fully known, not that the tile is empty. */
  fraction: number | null;
}
/** Inspect only known descriptors. No directory or payload downloads. Empty
 * layers have no block, so they must not count as missing cache entries. */
export function cacheCoverage(
  view: TileView,
  has: (key: string) => boolean,
): CachedTile[] {
  if (!view.layers.length) return [];
  const n = 2 ** view.zoom;
  const [w, north, e, south] = view.bounds;
  const cells = new Map<string, CachedTile>();
  const xmin = Math.max(0, Math.floor(w * n)),
    xmax = Math.min(n - 1, Math.floor(e * n));
  const ymin = Math.max(0, Math.floor(north * n)),
    ymax = Math.min(n - 1, Math.floor(south * n));
  // Guard pathological cameras; normal views contain tens of cells.
  if ((xmax - xmin + 1) * (ymax - ymin + 1) > 16384) return [];
  for (let y = ymin; y <= ymax; y++)
    for (let x = xmin; x <= xmax; x++)
      cells.set(`${x}/${y}`, {
        z: view.zoom,
        x,
        y,
        total: 0,
        cached: 0,
        fraction: null,
      });
  for (const b of view.blocks) {
    if (b.z !== view.zoom) continue;
    const cell = cells.get(`${b.x}/${b.y}`);
    if (cell) {
      cell.total++;
      if (has(b.key)) cell.cached++;
    }
  }
  for (const cell of cells.values())
    cell.fraction = view.complete
      ? cell.total
        ? cell.cached / cell.total
        : 0
      : null;
  return [...cells.values()];
}
