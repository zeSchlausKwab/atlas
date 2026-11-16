import { project, unproject } from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import type { Bounds } from "../../features/src/index";
import { overlaps } from "../../features/src/pages";

export const BORDER_ROOT = "boundary-display/index";
export const BORDER_PAGE_BYTES = 1024 ** 2;
export interface Border {
  id: string;
  level: number;
  bbox: Bounds;
  lines: [number, number][][];
}
export interface BorderPage {
  key: string;
  level: number;
  bbox: Bounds;
  count: number;
}
export interface BorderCatalog {
  schema: "boundary-display-v1";
  count: number;
  pages: BorderPage[];
}
export const borderMinZoom = (level: number) =>
  level <= 2 ? 0 : level <= 4 ? 3 : level <= 6 ? 5 : level <= 8 ? 8 : 10;
export const hasBorderDisplay = (r: AtlasReader) =>
  r.index.manifest.capabilities.includes("boundary-rendering");
const boundsValid = (b: unknown): b is Bounds =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -180 &&
  b[2] <= 180 &&
  b[1] >= -85 &&
  b[3] <= 85 &&
  b[0] <= b[2] &&
  b[1] <= b[3];
const levelValid = (v: number) => Number.isInteger(v) && v >= 1 && v <= 12;
const contains = (a: Bounds, b: Bounds) =>
  a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
export function validateBorderCatalog(v: unknown): BorderCatalog {
  const c = v as BorderCatalog;
  if (
    !c ||
    c.schema !== "boundary-display-v1" ||
    !Number.isSafeInteger(c.count) ||
    c.count < 0 ||
    !Array.isArray(c.pages) ||
    c.pages.length > 100000 ||
    c.pages.some(
      (p) =>
        !p ||
        !/^boundary-display\/16\/\d+\/\d+$/.test(p.key) ||
        p.key
          .split("/")
          .slice(-2)
          .some((n) => Number(n) >= 65536) ||
        !levelValid(p.level) ||
        !boundsValid(p.bbox) ||
        !Number.isInteger(p.count) ||
        p.count < 1 ||
        p.count > 64,
    ) ||
    c.pages.reduce((n, p) => n + p.count, 0) !== c.count ||
    new Set(c.pages.map((p) => p.key)).size !== c.pages.length
  )
    throw new Error("Invalid administrative border display index");
  return c;
}
export function validateBorderPage(v: unknown, page: BorderPage): Border[] {
  const data = v as { schema: string; borders: Border[] };
  if (
    !data ||
    data.schema !== "boundary-lines-v1" ||
    !Array.isArray(data.borders) ||
    data.borders.length !== page.count
  )
    throw new Error("Invalid administrative border display page");
  for (const b of data.borders) {
    if (
      !b ||
      typeof b.id !== "string" ||
      b.id.length > 128 ||
      b.level !== page.level ||
      !boundsValid(b.bbox) ||
      !contains(page.bbox, b.bbox) ||
      !Array.isArray(b.lines) ||
      b.lines.some(
        (line) =>
          !Array.isArray(line) ||
          line.length < 2 ||
          line.some(
            (p, i) =>
              !Array.isArray(p) ||
              p.length !== 2 ||
              !p.every(Number.isFinite) ||
              p[0] < b.bbox[0] ||
              p[0] > b.bbox[2] ||
              p[1] < b.bbox[1] ||
              p[1] > b.bbox[3] ||
              (i > 0 && Math.abs(p[0] - line[i - 1]![0]) > 180),
          ),
      )
    )
      throw new Error("Invalid administrative border lines");
  }
  return data.borders;
}
/** The index uses geographic extents; the renderer's camera uses Mercator. */
export function visibleBorderPages(
  c: BorderCatalog,
  view: Bounds,
  zoom: number,
) {
  const w = unproject(view[0], view[3]),
    e = unproject(view[2], view[1]);
  const bounds: Bounds = [w[0], w[1], e[0], e[1]];
  return c.pages.filter(
    (p) => borderMinZoom(p.level) <= zoom && overlaps(p.bbox, bounds),
  );
}

/** Display-only Douglas–Peucker. Exact polygons are stored separately, unchanged.
 * Split date-line jumps before simplifying so no border crosses the entire map. */
export function simplifyBorder(
  ring: number[][],
  zoom: number,
): [number, number][][] {
  const result: [number, number][][] = [],
    segments: [number, number][][] = [[]];
  for (const p of ring) {
    let line = segments.at(-1)!;
    if (line.length && Math.abs(p[0]! - line.at(-1)![0]) > 180)
      segments.push((line = []));
    line.push([p[0]!, p[1]!]);
  }
  const tolerance2 = (0.25 / (256 * 2 ** zoom)) ** 2;
  for (const line of segments) {
    if (line.length < 2) continue;
    const points = line.map((p) => project(...p)),
      keep = new Uint8Array(line.length);
    keep[0] = keep[line.length - 1] = 1;
    const stack = [0, line.length - 1];
    while (stack.length) {
      const end = stack.pop()!,
        start = stack.pop()!,
        a = points[start]!,
        b = points[end]!;
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length2 = dx * dx + dy * dy;
      let far = -1,
        max = tolerance2;
      for (let i = start + 1; i < end; i++) {
        const p = points[i]!,
          t = length2
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2,
                ),
              )
            : 0;
        const d = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
        if (d > max) {
          max = d;
          far = i;
        }
      }
      if (far >= 0) {
        keep[far] = 1;
        stack.push(start, far, far, end);
      }
    }
    const simplified = line.filter((_, i) => keep[i]);
    if (
      simplified.some(
        (p) => p[0] !== simplified[0]![0] || p[1] !== simplified[0]![1],
      )
    )
      result.push(simplified);
  }
  return result;
}
