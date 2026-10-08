import type { Position } from "./model";
/** Interior scanline anchor; holes participate in the parity fill, so courtyards stay empty. */
export function areaAnchor(polygons: Position[][][]): Position | undefined {
  let best: Position | undefined,
    width = -1;
  for (const rings of polygons) {
    if (!rings[0]?.length) continue;
    const ys = rings[0].map((p) => p[1]),
      lo = Math.min(...ys),
      hi = Math.max(...ys);
    for (const fraction of [0.5, 0.25, 0.75]) {
      const y = lo + (hi - lo) * fraction,
        xs: number[] = [];
      for (const ring of rings)
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1]!,
            b = ring[i]!;
          if (a[1] > y !== b[1] > y)
            xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i += 2) {
        const d = xs[i]! - xs[i - 1]!;
        if (d > width) {
          width = d;
          best = [(xs[i]! + xs[i - 1]!) / 2, y];
        }
      }
    }
  }
  return best;
}
