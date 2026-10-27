import { project, unproject } from "../../format/src/index";
import type {
  LocationBlock,
  StreetBlock,
  Position,
} from "../../geocoding/src/model";
import {
  roadMinZoom,
  poiMinZoom,
  LABEL_ZOOM,
  type LabelBlock,
  type RoadLabel,
} from "./index";
/** Split by grid boundaries so a long road remains labelable in every cell it crosses. */
export function buildLabels(
  locations: LocationBlock,
  streets: StreetBlock,
): Map<string, LabelBlock> {
  const buckets = new Map<string, LabelBlock>(),
    n = 2 ** LABEL_ZOOM;
  function bucket(x: number, y: number) {
    const key = `labels/${LABEL_ZOOM}/${x}/${y}`;
    let b = buckets.get(key);
    if (!b) {
      b = { schema: "labels-v1", roads: [], pois: [] };
      buckets.set(key, b);
    }
    return b;
  }
  for (const poi of locations.records)
    if (poi.kind === "poi") {
      const p = project(...poi.coordinates);
      bucket(
        Math.min(n - 1, Math.max(0, Math.floor(p[0] * n))),
        Math.min(n - 1, Math.max(0, Math.floor(p[1] * n))),
      ).pois.push({
        id: poi.id,
        name: poi.name,
        aliases: poi.aliases,
        kind: "poi",
        category: poi.category,
        coordinates: poi.coordinates,
      });
    }
  for (const road of streets.streets) {
    if (!road.name) continue;
    const fragments = new Map<string, RoadLabel>();
    for (let i = 1; i < road.coordinates.length; i++) {
      const a = project(...road.coordinates[i - 1]!),
        b = project(...road.coordinates[i]!);
      const ts = [0, 1];
      for (const axis of [0, 1] as const) {
        const d = b[axis] - a[axis];
        if (Math.abs(d) < 1e-14) continue;
        const lo = Math.floor(Math.min(a[axis], b[axis]) * n) + 1,
          hi = Math.floor(Math.max(a[axis], b[axis]) * n);
        for (let k = lo; k <= hi; k++) {
          const t = (k / n - a[axis]) / d;
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      ts.sort((a, b) => a - b);
      for (let j = 1; j < ts.length; j++) {
        const lo = ts[j - 1]!,
          hi = ts[j]!;
        if (hi - lo < 1e-12) continue;
        const point = (t: number): Position => [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
        ];
        const mid = point((lo + hi) / 2),
          x = Math.floor(mid[0] * n),
          y = Math.floor(mid[1] * n);
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        const key = `${x}/${y}`,
          start = unproject(...point(lo)),
          end = unproject(...point(hi)),
          prior = fragments.get(key),
          last = prior?.coordinates.at(-1);
        if (
          prior &&
          last &&
          Math.hypot(last[0] - start[0], last[1] - start[1]) < 1e-10
        )
          prior.coordinates.push(end);
        else {
          const part = {
            id: road.id,
            name: road.name,
            category: road.category,
            coordinates: [start, end],
          };
          bucket(x, y).roads.push(part);
          fragments.set(key, part);
        }
      }
    }
  }
  return buckets;
}

/** Each tier holds only the records that first become visible at that zoom. */
export function partitionLabels(combined: Map<string, LabelBlock>) {
  const result = new Map<string, LabelBlock>();
  for (const [cell, data] of combined) {
    for (const kind of ["roads", "pois"] as const) {
      for (const item of data[kind]) {
        const minZoom =
          kind === "roads"
            ? roadMinZoom(item.category)
            : poiMinZoom(item.category);
        const key = `${cell}/${kind}/${minZoom}`;
        let block = result.get(key);
        if (!block) {
          block = { schema: "labels-v1", roads: [], pois: [] };
          result.set(key, block);
        }
        if (kind === "roads") block.roads.push(item as RoadLabel);
        else block.pois.push(item as LabelBlock["pois"][number]);
      }
    }
  }
  return result;
}
