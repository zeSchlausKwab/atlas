import { unproject } from "../../format/src/index";
import { validPosition, type Position } from "../../geocoding/src/model";
export type Polygon = Position[];
const EPS = 1e-12;
const cross = (a: Position, b: Position) => a[0] * b[1] - a[1] * b[0];
const sub = (a: Position, b: Position): Position => [a[0] - b[0], a[1] - b[1]];
export function bounds(p: Polygon): [number, number, number, number] {
  return [
    Math.min(...p.map((v) => v[0])),
    Math.min(...p.map((v) => v[1])),
    Math.max(...p.map((v) => v[0])),
    Math.max(...p.map((v) => v[1])),
  ];
}
function onSegment(p: Position, a: Position, b: Position) {
  return (
    Math.abs(cross(sub(p, a), sub(b, a))) < EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS
  );
}
export function inside(p: Position, polygon: Polygon) {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!,
      b = polygon[i]!;
    if (onSegment(p, a, b)) return true;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      yes = !yes;
  }
  return yes;
}
function intersection(
  a: Position,
  b: Position,
  c: Position,
  d: Position,
): number[] {
  const r = sub(b, a),
    s = sub(d, c),
    q = sub(c, a),
    den = cross(r, s);
  if (Math.abs(den) < EPS) {
    if (Math.abs(cross(q, r)) > EPS) return [];
    const k = Math.abs(r[0]) > Math.abs(r[1]) ? 0 : 1;
    if (Math.abs(r[k]!) < EPS) return [];
    return [c, d]
      .filter((p) => onSegment(p, a, b))
      .map((p) => (p[k]! - a[k]!) / r[k]!);
  }
  const t = cross(q, s) / den,
    u = cross(q, r) / den;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
    ? [Math.max(0, Math.min(1, t))]
    : [];
}
export function validatePolygon(p: Polygon) {
  if (p.length < 3 || p.length > 128 || !p.every(validPosition))
    throw new Error("Draw 3–128 valid corners.");
  const b = bounds(p);
  // An explicit world rectangle is unambiguous in our planar map domain.
  // Other wide polygons still have ambiguous date-line semantics.
  const worldRectangle =
    p.length === 4 &&
    b[0] === -180 &&
    b[2] === 180 &&
    p.every(
      ([x, y]) => (x === -180 || x === 180) && (y === b[1] || y === b[3]),
    );
  if (b[2] - b[0] > 180 && !worldRectangle)
    throw new Error("Date-line crossing polygons are not supported yet.");
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!,
      b = p[(i + 1) % p.length]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8)
      throw new Error("Corners must be distinct.");
    area += cross(a, b);
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || (i === 0 && j === p.length - 1)) continue;
      const c = p[j]!,
        d = p[(j + 1) % p.length]!;
      if (
        intersection(a, b, c, d).length ||
        onSegment(a, c, d) ||
        onSegment(b, c, d)
      )
        throw new Error("Polygon edges must not cross or touch.");
    }
  }
  if (Math.abs(area) < 1e-10) throw new Error("Draw an area, not a line.");
}
/** Returns every interior interval; concave polygons can split a segment more than once. */
export function clipSegment(
  a: Position,
  b: Position,
  p: Polygon,
): [number, number][] {
  const box = bounds(p);
  if (
    Math.max(a[0], b[0]) < box[0] ||
    Math.min(a[0], b[0]) > box[2] ||
    Math.max(a[1], b[1]) < box[1] ||
    Math.min(a[1], b[1]) > box[3]
  )
    return [];
  const ts = [0, 1];
  for (let i = 0; i < p.length; i++)
    ts.push(...intersection(a, b, p[i]!, p[(i + 1) % p.length]!));
  ts.sort((a, b) => a - b);
  const unique = ts.filter((t, i) => i === 0 || t - ts[i - 1]! > EPS),
    result: [number, number][] = [];
  for (let i = 1; i < unique.length; i++) {
    const lo = unique[i - 1]!,
      hi = unique[i]!,
      t = (lo + hi) / 2;
    if (inside(interpolate(a, b, t), p)) {
      const previous = result[result.length - 1];
      if (previous && Math.abs(previous[1] - lo) < EPS) previous[1] = hi;
      else result.push([lo, hi]);
    }
  }
  return result;
}
export const interpolate = (a: Position, b: Position, t: number): Position => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
export function intersectsRectangle(
  p: Polygon,
  b: [number, number, number, number],
) {
  if (
    p.some((v) => v[0] >= b[0] && v[0] <= b[2] && v[1] >= b[1] && v[1] <= b[3])
  )
    return true;
  const corners: Polygon = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
  ];
  if (corners.some((v) => inside(v, p))) return true;
  return p.some(
    (v, i) => clipSegment(v, p[(i + 1) % p.length]!, corners).length > 0,
  );
}

/** A cell belongs to the selection if it or one of its padding neighbours intersects the polygon. */
export function selectedCell(
  polygon: Polygon,
  z: number,
  x: number,
  y: number,
  padding = 0,
) {
  const n = 2 ** z,
    sw = unproject(
      Math.max(0, x - padding) / n,
      Math.min(n, y + 1 + padding) / n,
    ),
    ne = unproject(
      Math.min(n, x + 1 + padding) / n,
      Math.max(0, y - padding) / n,
    );
  return intersectsRectangle(polygon, [...sw, ...ne]);
}
