/** Task-local sampled fields. The model receives descriptors, never the sample arrays. */
import { contours } from "d3-contour";
import pointInPolygon from "@turf/boolean-point-in-polygon";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import area from "@turf/area";
import type {
  Feature,
  FeatureCollection,
  Position,
  MultiPolygon,
} from "geojson";
import {
  fc,
  rect,
  polygon,
  boundsOf,
  coordinates,
  segments,
  BoxTree,
  validBounds,
  positive,
  numeric,
  property,
  type Bounds,
  type Surface,
  type Output,
} from "./index";
import { checkpoint, validateCoordinates } from "./construction";

type XY = [number, number];
type Segment = { a: XY; b: XY; box: Bounds };
const boxDistance = (p: XY, b: Bounds) =>
  Math.hypot(
    Math.max(b[0] - p[0], 0, p[0] - b[2]),
    Math.max(b[1] - p[1], 0, p[1] - b[3]),
  );
function segmentDistance(p: XY, s: Segment) {
  const dx = s.b[0] - s.a[0],
    dy = s.b[1] - s.a[1],
    den = dx * dx + dy * dy;
  const t = den
    ? Math.max(
        0,
        Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / den),
      )
    : 0;
  return Math.hypot(p[0] - s.a[0] - t * dx, p[1] - s.a[1] - t * dy);
}
/** Branch-and-bound nearest segment index; exact within the stated local planar metric. */
class SegmentTree {
  readonly box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  readonly children?: [SegmentTree, SegmentTree];
  readonly entries?: Segment[];
  constructor(entries: Segment[]) {
    for (const e of entries) {
      this.box[0] = Math.min(this.box[0], e.box[0]);
      this.box[1] = Math.min(this.box[1], e.box[1]);
      this.box[2] = Math.max(this.box[2], e.box[2]);
      this.box[3] = Math.max(this.box[3], e.box[3]);
    }
    if (entries.length <= 16) this.entries = entries;
    else {
      const axis =
        this.box[2] - this.box[0] > this.box[3] - this.box[1] ? 0 : 1;
      entries.sort(
        (a, b) =>
          a.box[axis]! + a.box[axis + 2]! - b.box[axis]! - b.box[axis + 2]!,
      );
      const mid = entries.length >> 1;
      this.children = [
        new SegmentTree(entries.slice(0, mid)),
        new SegmentTree(entries.slice(mid)),
      ];
    }
  }
  nearest(p: XY, best = Infinity): number {
    if (boxDistance(p, this.box) >= best) return best;
    if (this.entries)
      for (const e of this.entries)
        best = Math.min(best, segmentDistance(p, e));
    else {
      const [a, b] = this.children!;
      const nearA = boxDistance(p, a.box) < boxDistance(p, b.box);
      best = (nearA ? a : b).nearest(p, best);
      best = (nearA ? b : a).nearest(p, best);
    }
    return best;
  }
}
export interface FieldInput {
  kind: "distance" | "density";
  bounds: Bounds;
  cellMeters: number;
  bandwidthMeters?: number;
  weightField?: string;
  weightUnit?: string;
}
export interface SampledField {
  readonly values: Float64Array;
  readonly nx: number;
  readonly ny: number;
  readonly bounds: Bounds;
  readonly description: {
    kind: FieldInput["kind"];
    unit: string;
    requestedCellMeters: number;
    spacingMeters: XY;
    dimensions: XY;
    samples: number;
    sampleBytes: number;
    knownSamples: number;
    unknownSamples: number;
    min: number | null;
    max: number | null;
    sourceFeatures: number;
    acceptedPoints: number;
    unknownWeights: number;
    bounds: Bounds;
    parameters: FieldInput;
    notes: string[];
    projection: { name: string; center: XY; eastWestScaleVariation: number };
  };
}
export async function createField(
  input: FieldInput,
  source: FeatureCollection,
  signal: AbortSignal,
  progress?: (s: string) => void,
): Promise<SampledField> {
  const tick = checkpoint(signal, progress);
  await tick("Indexing field geometry");
  validBounds(input.bounds);
  positive(input.cellMeters, "cellMeters");
  validateCoordinates(source);
  if (!["distance", "density"].includes(input.kind))
    throw new Error("Unknown field kind");
  const b = [...input.bounds] as Bounds,
    lon = (b[0] + b[2]) / 2,
    lat = (b[1] + b[3]) / 2;
  const radians = Math.PI / 180,
    my = 6371008.8 * radians,
    mx = my * Math.cos(lat * radians);
  const project = (p: Position): XY => [(p[0]! - lon) * mx, (p[1]! - lat) * my];
  // Advertise metric limitations instead of silently using degree distances as metres.
  let minLat = b[1],
    maxLat = b[3],
    minLon = b[0],
    maxLon = b[2];
  for (const f of source.features) {
    const s = boundsOf(f);
    minLat = Math.min(minLat, s[1]);
    maxLat = Math.max(maxLat, s[3]);
    minLon = Math.min(minLon, s[0]);
    maxLon = Math.max(maxLon, s[2]);
  }
  const variation = Math.max(
    Math.abs(Math.cos(lat * radians) / Math.cos(minLat * radians) - 1),
    Math.abs(Math.cos(lat * radians) / Math.cos(maxLat * radians) - 1),
  );
  if (variation > 0.02 || maxLon - minLon > 20)
    throw new Error(
      "This field uses a local planar metric. Reduce the region/source extent (east–west scale variation must stay below 2%, longitude span below 20°); use spatial_bands for geographic buffers.",
    );
  const width = (b[2] - b[0]) * mx,
    height = (b[3] - b[1]) * my;
  const nx = Math.max(2, Math.ceil(width / input.cellMeters) + 1),
    ny = Math.max(2, Math.ceil(height / input.cellMeters) + 1);
  if (!Number.isSafeInteger(nx * ny) || nx * ny > 0xffffffff)
    throw new Error(
      "Field dimensions exceed the runtime array representation; increase cellMeters",
    );
  let values: Float64Array;
  try {
    values = new Float64Array(nx * ny);
  } catch {
    throw new Error(
      "Could not allocate field samples; increase cellMeters or reduce the area",
    );
  }
  const surfaces = source.features.filter(polygon),
    surfacesIndex = new BoxTree(
      surfaces.map((f, index) => ({ box: boundsOf(f), index })),
    );
  const edgeList: Segment[] = [],
    points: Array<{ p: XY; weight: number }> = [];
  let unknownWeights = 0;
  if (input.kind === "density")
    positive(input.bandwidthMeters, "bandwidthMeters");
  for (const f of source.features) {
    await tick("Indexing field geometry");
    if (input.kind === "density") {
      if (f.geometry.type !== "Point" && f.geometry.type !== "MultiPoint")
        throw new Error(
          "Density requires points; use spatial_points explicitly for representative locations",
        );
      const weight = input.weightField
        ? property(f.properties, input.weightField)
        : 1;
      if (!numeric(weight)) {
        unknownWeights++;
        continue;
      }
      if (weight < 0) throw new Error("Density weights must be non-negative");
      for (const p of coordinates(f.geometry))
        points.push({ p: project(p), weight });
    } else {
      const add = (a: Position, b: Position) => {
        const p = project(a),
          q = project(b);
        edgeList.push({
          a: p,
          b: q,
          box: [
            Math.min(p[0], q[0]),
            Math.min(p[1], q[1]),
            Math.max(p[0], q[0]),
            Math.max(p[1], q[1]),
          ],
        });
      };
      if (f.geometry.type === "Point" || f.geometry.type === "MultiPoint")
        for (const p of coordinates(f.geometry)) add(p, p);
      else
        for (const line of segments(f.geometry))
          for (let i = 1; i < line.length; i++) add(line[i - 1]!, line[i]!);
    }
  }
  const edges = new SegmentTree(edgeList),
    pointIndex = new BoxTree(
      points.map(({ p }, index) => ({ box: [p[0], p[1], p[0], p[1]], index })),
    );
  const bandwidth = input.bandwidthMeters ?? 1,
    support = 4 * bandwidth;
  let min = Infinity,
    max = -Infinity,
    known = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if ((x & 255) === 0) await tick(`Sampling field row ${y + 1}/${ny}`);
      const ll: XY = [
          b[0] + (x / (nx - 1)) * (b[2] - b[0]),
          b[3] - (y / (ny - 1)) * (b[3] - b[1]),
        ],
        p = project(ll);
      let value = NaN;
      if (input.kind === "distance" && edgeList.length) {
        value = surfacesIndex
          .search([ll[0], ll[1], ll[0], ll[1]])
          .some((i) => pointInPolygon(ll, surfaces[i]!))
          ? 0
          : edges.nearest(p);
      } else if (input.kind === "density" && points.length) {
        value = 0;
        for (const i of pointIndex.search([
          p[0] - support,
          p[1] - support,
          p[0] + support,
          p[1] + support,
        ])) {
          const q = points[i]!,
            r2 = (q.p[0] - p[0]) ** 2 + (q.p[1] - p[1]) ** 2;
          if (r2 <= support * support)
            value += q.weight * Math.exp(-r2 / (2 * bandwidth ** 2));
        }
        value *= 1e6 / (2 * Math.PI * bandwidth ** 2);
      }
      values[y * nx + x] = value;
      if (Number.isFinite(value)) {
        known++;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  signal.throwIfAborted();
  const unit =
    input.kind === "distance"
      ? "m"
      : `${input.weightField ? (input.weightUnit ?? "weight") : "retained points"}/km²`;
  return {
    values,
    nx,
    ny,
    bounds: b,
    description: {
      kind: input.kind,
      unit,
      requestedCellMeters: input.cellMeters,
      spacingMeters: [width / (nx - 1), height / (ny - 1)],
      dimensions: [nx, ny],
      samples: values.length,
      sampleBytes: values.byteLength,
      knownSamples: known,
      unknownSamples: values.length - known,
      min: known ? min : null,
      max: known ? max : null,
      sourceFeatures: source.features.length,
      acceptedPoints: points.length,
      unknownWeights,
      bounds: b,
      parameters: structuredClone(input),
      projection: {
        name: "local equirectangular, spherical Earth",
        center: [lon, lat],
        eastWestScaleVariation: variation,
      },
      notes: [
        "Samples lie on an inclusive regular lattice. Contours interpolate between samples; cellMeters controls spatial resolution, not source precision. Sampling can miss features narrower than the spacing.",
        input.kind === "distance"
          ? "Distance to retained geometry: polygon interiors are zero, holes are outside, lines are centerlines. This is not flood depth, risk or travel time."
          : "Gaussian kernel density of retained points/weights, truncated at four bandwidths (0.034% kernel mass omitted), without boundary correction; not population or observed coverage.",
        "Only supplied source features contribute. Query a padded area first; missing source coverage remains unknown. Empty sources produce unknown samples, never a false zero field.",
      ],
    },
  };
}
export interface ContourInput {
  thresholds: number[];
  mode?: "bands" | "lines";
}
export async function fieldContours(
  field: SampledField,
  input: ContourInput,
  signal: AbortSignal,
  progress?: (s: string) => void,
): Promise<Output> {
  const tick = checkpoint(signal, progress);
  await tick("Tracing cached field contours");
  const thresholds = input.thresholds,
    mode = input.mode ?? "bands";
  if (!["bands", "lines"].includes(mode))
    throw new Error("Unknown contour mode");
  if (
    !Array.isArray(thresholds) ||
    thresholds.length < (mode === "bands" ? 2 : 1) ||
    thresholds.some(
      (v, i) => !Number.isFinite(v) || (i > 0 && v <= thresholds[i - 1]!),
    )
  )
    throw new Error(
      "Use finite, strictly increasing thresholds; bands need at least two endpoints",
    );
  const { nx, ny, values, bounds: b } = field;
  const generator = contours().size([nx, ny]).smooth(true);
  const ll = (p: Position): Position => [
    b[0] + ((p[0]! - 0.5) / (nx - 1)) * (b[2] - b[0]),
    b[3] - ((p[1]! - 0.5) / (ny - 1)) * (b[3] - b[1]),
  ];
  const region = rect([0.5, 0.5, nx - 0.5, ny - 0.5]);
  const features: Feature[] = [];
  let previous: Surface | null = null;
  for (let i = 0; i < thresholds.length; i++) {
    const level = thresholds[i]!;
    await tick(`Tracing contour ${i + 1}/${thresholds.length}`);
    // d3 only indexes values/length; its DefinitelyTyped signature excludes typed arrays.
    const trace = generator.contour as (
      samples: ArrayLike<number>,
      threshold: number,
    ) => ReturnType<typeof generator.contour>;
    const g = trace(values, level);
    const raw: Feature<MultiPolygon> = {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: g.coordinates },
    };
    if (mode === "lines") {
      // d3 closes superlevel regions around the field. Discard virtual-border segments;
      // these are domain edges, not isolines. Every genuine segment stays on the lattice.
      const inside = (p: Position) =>
        p[0]! >= 0.5 && p[0]! <= nx - 0.5 && p[1]! >= 0.5 && p[1]! <= ny - 0.5;
      const lines: Position[][] = [];
      for (const poly of g.coordinates)
        for (const ring of poly) {
          const parts: Position[][] = [];
          let part: Position[] = [];
          for (let j = 1; j < ring.length; j++) {
            const a = ring[j - 1]!,
              c = ring[j]!;
            if (inside(a) && inside(c)) {
              if (!part.length) part.push(a);
              part.push(c);
            } else if (part.length) {
              parts.push(part);
              part = [];
            }
          }
          if (part.length) parts.push(part);
          if (
            parts.length > 1 &&
            parts[0]![0] === ring[0] &&
            parts.at(-1)!.at(-1) === ring.at(-1)
          ) {
            const last = parts.pop()!;
            parts[0] = [...last, ...parts[0]!.slice(1)];
          }
          lines.push(...parts.map((p) => p.map(ll)));
        }
      if (lines.length)
        features.push({
          type: "Feature",
          geometry: { type: "MultiLineString", coordinates: lines },
          properties: {
            value: level,
            label: `${level} ${field.description.unit}`,
            unit: field.description.unit,
          },
        });
    } else {
      const current = g.coordinates.length
        ? intersect(fc([raw, region]))
        : null;
      if (i > 0 && previous) {
        const band = current ? difference(fc([previous, current])) : previous;
        if (band) {
          const geometry =
            band.geometry.type === "Polygon"
              ? {
                  type: "Polygon" as const,
                  coordinates: band.geometry.coordinates.map((r) => r.map(ll)),
                }
              : {
                  type: "MultiPolygon" as const,
                  coordinates: band.geometry.coordinates.map((p) =>
                    p.map((r) => r.map(ll)),
                  ),
                };
          const feature: Feature = {
            type: "Feature",
            geometry,
            properties: {
              bandIndex: i - 1,
              lower: thresholds[i - 1],
              upper: level,
              unit: field.description.unit,
              label: `${thresholds[i - 1]}–${level} ${field.description.unit}`,
            },
          };
          feature.properties!.areaM2 = area(feature);
          features.push(feature);
        }
      }
      previous = current;
    }
  }
  signal.throwIfAborted();
  return {
    collection: fc(features),
    summary: {
      mode,
      features: features.length,
      thresholds,
      field: field.description,
    },
    units: {
      value: field.description.unit,
      lower: field.description.unit,
      upper: field.description.unit,
      areaM2: "m²",
    },
    notes: [
      ...field.description.notes,
      "Bands are [lower,upper); values outside the requested endpoints are omitted. Field edges close filled polygons but are not drawn as isolines.",
    ],
  };
}
