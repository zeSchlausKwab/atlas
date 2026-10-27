import area from "@turf/area";
import length from "@turf/length";
import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import pointOnFeature from "@turf/point-on-feature";
import intersects from "@turf/boolean-intersects";
import pointInPolygon from "@turf/boolean-point-in-polygon";
import intersect from "@turf/intersect";
import union from "@turf/union";
import difference from "@turf/difference";
import distance from "@turf/distance";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import convex from "@turf/convex";
import bboxClip from "@turf/bbox-clip";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  Polygon,
  MultiPolygon,
  Position,
} from "geojson";

export type Bounds = [number, number, number, number];
export type Shape = Feature<Exclude<Geometry, { type: "GeometryCollection" }>>;
type Surface = Feature<Polygon | MultiPolygon>;
export type Properties = Record<string, unknown>;
export interface Output {
  collection: FeatureCollection;
  summary: Properties;
  units: Record<string, string>;
  notes: string[];
}
export interface SpatialInput {
  operation:
    | "measure"
    | "points"
    | "buffer"
    | "overlay"
    | "clip"
    | "hull"
    | "nearest"
    | "join"
    | "filter"
    | "grid";
  mode?: string;
  distanceMeters?: number;
  maxDistanceMeters?: number;
  bounds?: Bounds;
  cellMeters?: number;
  field?: string;
  excludeSameId?: boolean;
  invert?: boolean;
}
export const fc = (features: Feature[]): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});
const polygon = (f: Feature): f is Surface =>
  f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon";
const identity = (f: Feature, index: number) =>
  String(f.id ?? f.properties?.id ?? `feature-${index}`);
export function property(props: Properties | null, key: string): unknown {
  if (!props) return null;
  if (Object.hasOwn(props, key)) return props[key] ?? null;
  let value: unknown = props;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      return null;
    value = (value as Properties)[part];
  }
  return value ?? null;
}
export const numeric = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export function boundsOf(f: Feature): Bounds {
  const b: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  coordinates(f.geometry).forEach((p) => {
    b[0] = Math.min(b[0], p[0]!);
    b[1] = Math.min(b[1], p[1]!);
    b[2] = Math.max(b[2], p[0]!);
    b[3] = Math.max(b[3], p[1]!);
  });
  return b;
}
function coordinates(g: Geometry): Position[] {
  if (g.type === "GeometryCollection")
    throw new Error("Flatten GeometryCollections before spatial analysis");
  if (g.type === "Point") return [g.coordinates];
  if (g.type === "LineString" || g.type === "MultiPoint") return g.coordinates;
  if (g.type === "Polygon" || g.type === "MultiLineString")
    return g.coordinates.flat();
  return g.coordinates.flat(2);
}
function segments(g: Geometry): Position[][] {
  switch (g.type) {
    case "LineString":
      return [g.coordinates];
    case "MultiLineString":
    case "Polygon":
      return g.coordinates;
    case "MultiPolygon":
      return g.coordinates.flat();
    default:
      return [];
  }
}
export function rect(b: Bounds): Surface {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [b[0], b[1]],
          [b[2], b[1]],
          [b[2], b[3]],
          [b[0], b[3]],
          [b[0], b[1]],
        ],
      ],
    },
  };
}
function validBounds(b?: Bounds): asserts b is Bounds {
  if (
    !b ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    b[0] >= b[2] ||
    b[1] >= b[3] ||
    b[0] < -180 ||
    b[2] > 180 ||
    b[1] < -85 ||
    b[3] > 85
  )
    throw new Error(
      "Use non-crossing [west,south,east,north] bounds within ±85° latitude",
    );
}
function positive(
  value: number | undefined,
  name: string,
): asserts value is number {
  if (!numeric(value) || value <= 0)
    throw new Error(name + " must be a positive finite number");
}
function derived(
  f: Feature,
  props: Properties,
  geometry = f.geometry,
): Feature {
  const { bbox: _bbox, ...rest } = f;
  return {
    ...rest,
    geometry,
    properties: { ...f.properties, ...props, geometryType: geometry.type },
  };
}
function checkedGeometry(f: Feature) {
  if (!f.geometry)
    throw new Error("Prepare geometry:true for spatial operations");
  if (!coordinates(f.geometry).length)
    throw new Error("Empty geometry cannot be measured; filter it first");
  for (const line of segments(f.geometry))
    for (let i = 1; i < line.length; i++)
      if (Math.abs(line[i]![0]! - line[i - 1]![0]!) >= 180)
        throw new Error(
          "Split antimeridian-crossing geometry before spatial operations",
        );
}
/** Static bounding-box tree for repeated candidate lookups in a task. */
class BoxTree {
  private node?: {
    box: Bounds;
    left?: BoxTree;
    right?: BoxTree;
    entries?: Array<{ box: Bounds; index: number }>;
  };
  constructor(entries: Array<{ box: Bounds; index: number }>) {
    if (!entries.length) return;
    const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const e of entries) {
      box[0] = Math.min(box[0], e.box[0]);
      box[1] = Math.min(box[1], e.box[1]);
      box[2] = Math.max(box[2], e.box[2]);
      box[3] = Math.max(box[3], e.box[3]);
    }
    if (entries.length <= 16) this.node = { box, entries };
    else {
      const axis = box[2] - box[0] > box[3] - box[1] ? 0 : 1;
      entries.sort(
        (a, b) =>
          a.box[axis]! + a.box[axis + 2]! - (b.box[axis]! + b.box[axis + 2]!),
      );
      const mid = Math.floor(entries.length / 2);
      this.node = {
        box,
        left: new BoxTree(entries.slice(0, mid)),
        right: new BoxTree(entries.slice(mid)),
      };
    }
  }
  search(box: Bounds, out: number[] = []): number[] {
    const n = this.node;
    if (!n || !overlap(n.box, box)) return out;
    if (n.entries)
      for (const e of n.entries) {
        if (overlap(e.box, box)) out.push(e.index);
      }
    else {
      n.left!.search(box, out);
      n.right!.search(box, out);
    }
    return out;
  }
}
const overlap = (a: Bounds, b: Bounds) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function arcBounds(f: Feature): Bounds {
  const b = boundsOf(f);
  // A great-circle segment stays within its angular length of an endpoint.
  // Padding latitude conservatively avoids pruning a north/south-bowing arc.
  let span = 0;
  for (const line of segments(f.geometry))
    for (let i = 1; i < line.length; i++)
      span = Math.max(
        span,
        Math.abs(line[i]![0]! - line[i - 1]![0]!) +
          Math.abs(line[i]![1]! - line[i - 1]![1]!),
      );
  return [b[0], Math.max(-90, b[1] - span), b[2], Math.min(90, b[3] + span)];
}
function radiusBounds(p: Position, meters: number): Bounds {
  const a = meters / 6371008.8,
    lat = (p[1]! * Math.PI) / 180;
  if (a >= Math.PI || Math.abs(lat) + a >= Math.PI / 2)
    return [-180, -90, 180, 90];
  const lon = (Math.asin(Math.sin(a) / Math.cos(lat)) * 180) / Math.PI,
    d = (a * 180) / Math.PI;
  if (p[0]! - lon < -180 || p[0]! + lon > 180)
    return [-180, p[1]! - d, 180, p[1]! + d];
  return [p[0]! - lon, p[1]! - d, p[0]! + lon, p[1]! + d];
}
function closest(p: Position, f: Feature): { meters: number; point: Position } {
  const g = f.geometry;
  if (polygon(f) && pointInPolygon(p, f)) return { meters: 0, point: p };
  if (g.type === "Point")
    return {
      meters: distance(p, g.coordinates, { units: "meters" }),
      point: g.coordinates,
    };
  if (g.type === "MultiPoint")
    return g.coordinates
      .map((q) => ({ meters: distance(p, q, { units: "meters" }), point: q }))
      .sort((a, b) => a.meters - b.meters)[0]!;
  const lines = segments(g);
  const q = nearestPointOnLine(
    { type: "MultiLineString", coordinates: lines },
    p,
    { units: "meters" },
  );
  return { meters: q.properties.pointDistance, point: q.geometry.coordinates };
}
async function merged(
  features: Feature[],
  tick: () => Promise<void>,
): Promise<Surface | null> {
  let out: Surface | null = null;
  for (const f of features) {
    if (!polygon(f))
      throw new Error(
        "Polygon overlay requires only Polygon/MultiPolygon inputs; use spatial_filter for points or lines",
      );
    out = out
      ? union(fc([out, f]) as FeatureCollection<Polygon | MultiPolygon>)
      : f;
    await tick();
  }
  return out;
}

/** No I/O. All results retain source properties and explicit operation semantics. */
export async function spatialOperation(
  input: SpatialInput,
  source: FeatureCollection,
  target: FeatureCollection | undefined,
  signal: AbortSignal,
  progress: (message: string) => void = () => {},
): Promise<Output> {
  let steps = 0,
    lastYield = performance.now();
  const tick = async () => {
    signal.throwIfAborted();
    if (++steps % 64 === 0 || performance.now() - lastYield > 30) {
      progress(`${input.operation} · ${steps.toLocaleString()} items checked`);
      await new Promise<void>((r) => setTimeout(r, 0));
      lastYield = performance.now();
      signal.throwIfAborted();
    }
  };
  for (const f of [...source.features, ...(target?.features ?? [])]) {
    checkedGeometry(f);
    await tick();
  }
  const result: Output = {
    collection: fc([]),
    summary: { inputCount: source.features.length },
    units: {},
    notes: [
      "Retained source geometries only; coverage and unknown source attributes remain limitations.",
    ],
  };
  const out = result.collection.features;
  if (input.operation === "measure") {
    for (const f of source.features) {
      const isArea = polygon(f),
        lines = segments(f.geometry);
      const meters = lines.length
        ? length(
            {
              type: "Feature",
              properties: {},
              geometry: { type: "MultiLineString", coordinates: lines },
            },
            { units: "meters" },
          )
        : null;
      out.push(
        derived(f, {
          areaM2: isArea ? area(f) : null,
          lengthM: isArea ? null : meters,
          perimeterM: isArea ? meters : null,
        }),
      );
      await tick();
    }
    result.units = { areaM2: "m²", lengthM: "m", perimeterM: "m" };
    result.notes.push(
      "Spherical area subtracts holes; perimeter includes hole boundaries. Non-applicable metrics are null. Sum of feature areas/lengths may double-count overlaps or parallel tracks.",
    );
  } else if (input.operation === "points") {
    for (const f of source.features) {
      const p = input.mode === "centroid" ? centroid(f) : pointOnFeature(f);
      out.push(
        derived(f, { pointMethod: input.mode ?? "surface" }, p.geometry),
      );
      await tick();
    }
    result.notes.push(
      input.mode === "centroid"
        ? "Vertex-mean centroids can lie outside concave polygons or in holes."
        : "Representative surface points, not entrances or verified access points.",
    );
  } else if (input.operation === "buffer") {
    positive(input.distanceMeters, "distanceMeters");
    for (const f of source.features) {
      const b = buffer(f, input.distanceMeters, { units: "meters", steps: 16 });
      if (!b) throw new Error("Buffer failed for " + f.id);
      out.push(derived(f, { bufferMeters: input.distanceMeters }, b.geometry));
      await tick();
    }
    result.units = { bufferMeters: "m" };
    result.notes.push(
      "Approximate geographic buffers using a projection per feature and polygonal arcs; not travel-time areas. Overlaps remain separate; union them for a single region.",
    );
  } else if (input.operation === "overlay") {
    if (input.mode !== "union" && !target)
      throw new Error("Intersection and difference need another result");
    const a = await merged(source.features, tick),
      b = await merged(target?.features ?? [], tick);
    let shape: Surface | null;
    if (input.mode === "union")
      shape =
        a && b
          ? union(fc([a, b]) as FeatureCollection<Polygon | MultiPolygon>)
          : (a ?? b);
    else if (input.mode === "difference")
      shape =
        a && b
          ? difference(fc([a, b]) as FeatureCollection<Polygon | MultiPolygon>)
          : a;
    else {
      if (!target) throw new Error("Intersection needs another result");
      shape =
        a && b
          ? intersect(fc([a, b]) as FeatureCollection<Polygon | MultiPolygon>)
          : null;
    }
    if (shape)
      out.push({
        ...shape,
        id: "overlay",
        properties: { operation: input.mode, areaM2: area(shape) },
      });
    result.units = { areaM2: "m²" };
    result.notes.push(
      "Each side is dissolved before the set operation. Overlay attributes describe the combined area; source identities remain in provenance.",
    );
  } else if (input.operation === "clip") {
    validBounds(input.bounds);
    const box = rect(input.bounds);
    for (const f of source.features) {
      let shape: Feature | null = null;
      if (polygon(f))
        shape = intersect(
          fc([f, box]) as FeatureCollection<Polygon | MultiPolygon>,
        );
      else if (f.geometry.type === "Point")
        shape = pointInPolygon(f as Feature<GeoJSON.Point>, box) ? f : null;
      else if (f.geometry.type === "MultiPoint") {
        const points = f.geometry.coordinates.filter((p) =>
          pointInPolygon(p, box),
        );
        if (points.length)
          shape = derived(f, {}, { type: "MultiPoint", coordinates: points });
      } else {
        const clipped = bboxClip(
          f as Feature<LineString | MultiLineString>,
          input.bounds,
        );
        if (coordinates(clipped.geometry).length) shape = clipped;
      }
      if (shape) out.push(derived(f, { clipped: true }, shape.geometry));
      await tick();
    }
    result.notes.push(
      "Geometry clipped to the requested rectangle; measurement afterwards applies to clipped geometry.",
    );
  } else if (input.operation === "hull") {
    const shape = convex(source);
    if (shape)
      out.push({ ...shape, id: "hull", properties: { areaM2: area(shape) } });
    result.units = { areaM2: "m²" };
    result.notes.push(
      "Convex hull can include large gaps and is not actual coverage; collinear/fewer-than-three distinct vertices yield an empty result.",
    );
  } else if (input.operation === "nearest") {
    if (!target) throw new Error("Nearest needs a target result");
    positive(input.maxDistanceMeters, "maxDistanceMeters");
    const tree = new BoxTree(
      target.features.map((f, index) => ({ box: arcBounds(f), index })),
    );
    let matched = 0,
      candidates = 0;
    for (let index = 0; index < source.features.length; index++) {
      const f = source.features[index]!,
        p = pointOnFeature(f).geometry.coordinates;
      let best: { i: number; meters: number; point: Position } | undefined;
      for (const i of tree.search(radiusBounds(p, input.maxDistanceMeters))) {
        const other = target.features[i]!;
        if (input.excludeSameId && identity(other, i) === identity(f, index))
          continue;
        const d = closest(p, other);
        candidates++;
        if (
          d.meters <= input.maxDistanceMeters &&
          (!best ||
            d.meters < best.meters ||
            (d.meters === best.meters &&
              identity(other, i) < identity(target.features[best.i]!, best.i)))
        )
          best = { i, ...d };
        await tick();
      }
      if (best) matched++;
      const other = best ? target.features[best.i] : null;
      out.push(
        derived(
          f,
          {
            nearestId: other ? identity(other, best!.i) : null,
            nearestName: other?.properties?.name ?? null,
            distanceM: best?.meters ?? null,
            nearestPoint: best?.point ?? null,
            originPoint: p,
            matched: !!best,
          },
          input.mode === "connectors" && best
            ? { type: "LineString", coordinates: [p, best.point] }
            : f.geometry,
        ),
      );
      await tick();
    }
    result.summary = {
      ...result.summary,
      matched,
      unmatched: source.features.length - matched,
      candidateChecks: candidates,
      maxDistanceMeters: input.maxDistanceMeters,
    };
    result.units = { distanceM: "m" };
    result.notes.push(
      "Spherical straight-line distance from each source's representative point to target geometry, not footprint-to-footprint or route distance. Inside a target polygon gives zero. Null means no retained target within the requested radius; it is not a real-world absence. Connector mode retains unmatched source shapes.",
    );
  } else if (input.operation === "join" || input.operation === "filter") {
    if (!target) throw new Error("Spatial relation needs another result");
    const tree = new BoxTree(
      target.features.map((f, index) => ({ box: boundsOf(f), index })),
    );
    let pairs = 0;
    if (
      input.mode === "representative_within" &&
      target.features.some((f) => !polygon(f))
    )
      throw new Error("representative_within requires polygon targets");
    for (let index = 0; index < source.features.length; index++) {
      const f = source.features[index]!,
        p =
          input.mode === "representative_within"
            ? pointOnFeature(f)
            : undefined;
      const matches: number[] = [];
      for (const i of tree.search(boundsOf(p ?? f))) {
        const other = target.features[i]!;
        if (input.excludeSameId && identity(f, index) === identity(other, i))
          continue;
        if (p ? pointInPolygon(p, other as Surface) : intersects(f, other))
          matches.push(i);
        await tick();
      }
      matches.sort((a, b) => a - b);
      pairs += matches.length;
      if (input.operation === "join")
        out.push(
          derived(f, {
            matchCount: matches.length,
            matchIds: matches.map((i) => identity(target.features[i]!, i)),
            ...(input.field
              ? aggregate(
                  matches.map((i) =>
                    property(target.features[i]!.properties, input.field!),
                  ),
                )
              : {}),
          }),
        );
      else if (Boolean(matches.length) !== Boolean(input.invert)) out.push(f);
      await tick();
    }
    result.summary = { ...result.summary, pairs, outputCount: out.length };
    result.notes.push(
      input.mode === "representative_within"
        ? "Source representative points inside/on target polygons; polygon holes excluded."
        : "Geometry intersection includes touching boundaries and line crossings. Whole source features are retained; this is not clipping.",
    );
    if (input.field)
      result.notes.push(
        "Numeric aggregates ignore unknown/non-numeric values and report them separately. Overlapping targets can produce multiple matches.",
      );
  } else if (input.operation === "grid") {
    validBounds(input.bounds);
    positive(input.cellMeters, "cellMeters");
    const b = input.bounds,
      lat = (((b[1] + b[3]) / 2) * Math.PI) / 180;
    const dy = ((input.cellMeters / 6371008.8) * 180) / Math.PI,
      dx = dy / Math.cos(lat);
    const cols = Math.ceil((b[2] - b[0]) / dx),
      rows = Math.ceil((b[3] - b[1]) / dy);
    if (!Number.isSafeInteger(cols * rows))
      throw new Error("Grid dimensions exceed numeric precision");
    const buckets = new Map<number, number[]>();
    let outside = 0;
    for (let i = 0; i < source.features.length; i++) {
      const p = pointOnFeature(source.features[i]!).geometry.coordinates;
      if (p[0]! < b[0] || p[0]! > b[2] || p[1]! < b[1] || p[1]! > b[3])
        outside++;
      else {
        const x = Math.min(cols - 1, Math.floor((p[0]! - b[0]) / dx)),
          y = Math.min(rows - 1, Math.floor((p[1]! - b[1]) / dy)),
          key = y * cols + x;
        const list = buckets.get(key) ?? [];
        list.push(i);
        buckets.set(key, list);
      }
      await tick();
    }
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const cell = rect([
            b[0] + x * dx,
            b[1] + y * dy,
            Math.min(b[2], b[0] + (x + 1) * dx),
            Math.min(b[3], b[1] + (y + 1) * dy),
          ]),
          ids = buckets.get(y * cols + x) ?? [],
          areaM2 = area(cell);
        out.push({
          ...cell,
          id: `cell-${x}-${y}`,
          properties: {
            count: ids.length,
            areaM2,
            densityPerKm2: ids.length / (areaM2 / 1e6),
            ...(input.field
              ? aggregate(
                  ids.map((i) =>
                    property(source.features[i]!.properties, input.field!),
                  ),
                )
              : {}),
          },
        });
        await tick();
      }
    result.units = { areaM2: "m²", densityPerKm2: "features/km²" };
    result.summary = {
      ...result.summary,
      assigned: source.features.length - outside,
      outside,
      columns: cols,
      rows,
    };
    result.notes.push(
      "Each feature assigned once by representative surface point, not by intersected area or clipped line length. Approximate metre-sized geographic cells at the bounds' mid-latitude; density uses each cell's spherical area. Empty cells are zero retained observations, not proof of complete source coverage.",
    );
  } else throw new Error("Unknown spatial operation");
  signal.throwIfAborted();
  result.summary.outputCount = out.length;
  return result;
}
export function aggregate(values: unknown[]) {
  const numbers = values.filter(numeric);
  let sum = 0,
    min = Infinity,
    max = -Infinity;
  for (const n of numbers) {
    sum += n;
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  return {
    knownCount: numbers.length,
    unknownCount: values.length - numbers.length,
    sum: numbers.length ? sum : null,
    mean: numbers.length ? sum / numbers.length : null,
    min: numbers.length ? min : null,
    max: numbers.length ? max : null,
  };
}
