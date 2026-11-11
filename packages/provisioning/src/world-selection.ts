import type { Polygon } from "../../offline/src/geometry";
/** Canonical supported world extent, with any starting corner/winding. */
export function isWorldSelection(p: Polygon) {
  return (
    p.length === 4 &&
    new Set(p.map(([x, y]) => `${x},${y}`)).size === 4 &&
    p.every(([x, y]) => (x === -180 || x === 180) && (y === -85 || y === 85))
  );
}
