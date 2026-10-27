/** Geometry construction is deterministic and has no data-source or UI dependencies. */
import buffer from "@turf/buffer";
import union from "@turf/union";
import difference from "@turf/difference";
import intersect from "@turf/intersect";
import area from "@turf/area";
import valid from "@turf/boolean-valid";
import kinks from "@turf/kinks";
import pointInPolygon from "@turf/boolean-point-in-polygon";
import intersects from "@turf/boolean-intersects";
import type { Feature, FeatureCollection, Position } from "geojson";
import {
  fc,
  polygon,
  rect,
  validBounds,
  positive,
  checkedGeometry,
  coordinates,
  type Bounds,
  type Surface,
  type Output,
} from "./index";

export function checkpoint(
  signal: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  let last = 0;
  return async (message: string) => {
    signal.throwIfAborted();
    if (performance.now() - last < 25) return;
    progress(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    last = performance.now();
  };
}
export function validateCoordinates(source: FeatureCollection) {
  for (const f of source.features) {
    checkedGeometry(f);
    for (const p of coordinates(f.geometry))
      if (
        p.length !== 2 ||
        !p.every(Number.isFinite) ||
        Math.abs(p[0]!) > 180 ||
        Math.abs(p[1]!) > 85
      )
        throw new Error(
          "Use finite [longitude,latitude] coordinates within ±85° latitude",
        );
  }
}
/** JSTS steps are segments per quarter-circle; sagitta bounds round-join tessellation. */
function steps(radius: number, tolerance: number) {
  positive(radius, "radiusMeters");
  positive(tolerance, "toleranceMeters");
  const angle = Math.acos(1 - Math.min(tolerance / radius, 1));
  const n = Math.max(8, Math.ceil(Math.PI / (4 * angle)));
  if (!Number.isSafeInteger(n))
    throw new Error(
      "Tolerance is below floating-point precision for this radius",
    );
  return n;
}
async function dissolve(
  features: Surface[],
  tick: (s: string) => Promise<void>,
): Promise<Surface | null> {
  // Balanced unions avoid repeatedly reprocessing a growing, complex polygon.
  let level = features;
  while (level.length > 1) {
    const next: Surface[] = [];
    for (let i = 0; i < level.length; i += 2) {
      await tick(`Dissolving ${level.length} polygon parts`);
      const shape = level[i + 1]
        ? union(fc([level[i]!, level[i + 1]!]))
        : level[i]!;
      if (shape) next.push(shape);
    }
    level = next;
  }
  return level[0] ?? null;
}
async function buffered(
  source: FeatureCollection,
  radius: number,
  tolerance: number,
  tick: (s: string) => Promise<void>,
) {
  const n = steps(radius, tolerance),
    parts: Surface[] = [];
  for (let i = 0; i < source.features.length; i++) {
    await tick(
      `Buffering ${i + 1}/${source.features.length} geometries at ${radius} m`,
    );
    const result = buffer(source.features[i]!, radius, {
      units: "meters",
      steps: n,
    });
    if (!result || !polygon(result))
      throw new Error(
        `Could not buffer source geometry ${i}; no partial result was saved`,
      );
    parts.push(result);
  }
  return dissolve(parts, tick);
}
const notes = [
  "Approximate geographic buffers. toleranceMeters controls round-join tessellation, not source accuracy or total projection error.",
  "Polygon distances start at mapped area boundaries; line distances start at centerlines. These are proximity zones, not modeled flood hazard or network travel areas.",
  "Prepare source data beyond the analysis bounds by at least the largest distance. Clipping applies after buffering; unqueried neighboring objects can otherwise be missed.",
];
function output(
  features: Feature[],
  summary: Record<string, unknown>,
  extraNotes = notes,
): Output {
  return {
    collection: fc(features),
    summary,
    units: {
      fromMeters: "m",
      toMeters: "m",
      radiusMeters: "m",
      areaM2: "m²",
      toleranceMeters: "m",
    },
    notes: extraNotes,
  };
}
export interface BandsInput {
  distancesMeters: number[];
  excludeSource?: boolean;
  bounds?: Bounds;
  toleranceMeters?: number;
}
export async function distanceBands(
  input: BandsInput,
  source: FeatureCollection,
  signal: AbortSignal,
  progress?: (s: string) => void,
): Promise<Output> {
  const tick = checkpoint(signal, progress);
  await tick("Preparing distance bands");
  validateCoordinates(source);
  const distances = input.distancesMeters,
    tolerance = input.toleranceMeters ?? 2;
  if (
    !Array.isArray(distances) ||
    !distances.length ||
    distances.some(
      (v, i) =>
        !Number.isFinite(v) || v <= 0 || (i > 0 && v <= distances[i - 1]!),
    )
  )
    throw new Error(
      "distancesMeters must be positive, finite and strictly increasing",
    );
  positive(tolerance, "toleranceMeters");
  if (input.bounds) validBounds(input.bounds);
  const surfaces = source.features.filter(polygon);
  const original = await dissolve(surfaces, tick);
  let previous = input.excludeSource === false ? null : original;
  const features: Feature[] = [];
  for (let i = 0; i < distances.length; i++) {
    const outer = await buffered(source, distances[i]!, tolerance, tick);
    // Preserve nesting even if separate geographic buffer projections round differently.
    const nested = outer && original ? union(fc([outer, original])) : outer;
    const current = nested && previous ? union(fc([nested, previous])) : nested;
    let band =
      current && previous ? difference(fc([current, previous])) : current;
    previous = current;
    if (band && input.bounds) band = intersect(fc([band, rect(input.bounds)]));
    if (band)
      features.push({
        ...band,
        properties: {
          bandIndex: i,
          fromMeters: i ? distances[i - 1]! : 0,
          toMeters: distances[i],
          label: `${i ? distances[i - 1] : 0}–${distances[i]} m`,
          areaM2: area(band),
          toleranceMeters: tolerance,
        },
      });
    await tick(`Completed ${i + 1}/${distances.length} distance bands`);
  }
  signal.throwIfAborted();
  return output(features, {
    sourceFeatures: source.features.length,
    polygonFeatures: surfaces.length,
    lineFeatures: source.features.filter((f) =>
      /LineString$/.test(f.geometry.type),
    ).length,
    requestedBands: distances.length,
    returnedBands: features.length,
    excludeSource: input.excludeSource !== false,
  });
}
export interface ShapeInput {
  kind: "circle" | "rectangle" | "polygon" | "corridor";
  center?: Position;
  radiusMeters?: number;
  bounds?: Bounds;
  rings?: Position[][];
  toleranceMeters?: number;
}
export async function constructShape(
  input: ShapeInput,
  source: FeatureCollection | undefined,
  signal: AbortSignal,
  progress?: (s: string) => void,
): Promise<Output> {
  const tick = checkpoint(signal, progress);
  await tick("Constructing shape");
  const tolerance = input.toleranceMeters ?? 2;
  let shape: Surface | null;
  if (input.kind === "rectangle") {
    validBounds(input.bounds);
    shape = rect(input.bounds);
  } else if (input.kind === "polygon") {
    if (!input.rings?.length || input.rings.some((r) => r.length < 3))
      throw new Error(
        "Provide an outer ring and optional holes, each with at least three vertices",
      );
    const rings = input.rings.map((r) => {
      const copy = r.map((p) => [...p]);
      if (copy[0]![0] !== copy.at(-1)![0] || copy[0]![1] !== copy.at(-1)![1])
        copy.push([...copy[0]!]);
      return copy;
    });
    shape = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: rings },
    };
    validateCoordinates(fc([shape]));
    if (!valid(shape) || kinks(shape).features.length || area(shape) <= 0)
      throw new Error("Polygon has a degenerate or self-intersecting ring");
    const shell: Surface = {
      ...shape,
      geometry: { type: "Polygon", coordinates: [rings[0]!] },
    };
    for (let i = 1; i < rings.length; i++) {
      if (!pointInPolygon(rings[i]![0]!, shell, { ignoreBoundary: true }))
        throw new Error("Polygon holes must be strictly inside the outer ring");
      const hole: Surface = {
        ...shape,
        geometry: { type: "Polygon", coordinates: [rings[i]!] },
      };
      for (let j = 1; j < i; j++)
        if (
          intersects(hole, {
            ...shape,
            geometry: { type: "Polygon", coordinates: [rings[j]!] },
          })
        )
          throw new Error(
            "Polygon holes must not overlap or contain one another",
          );
    }
  } else if (input.kind === "circle" || input.kind === "corridor") {
    positive(input.radiusMeters, "radiusMeters");
    const geometry =
      input.kind === "circle"
        ? fc([
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: input.center ?? [] },
            },
          ])
        : source;
    if (!geometry) throw new Error("Corridor needs a cached line result");
    validateCoordinates(geometry);
    if (
      input.kind === "corridor" &&
      geometry.features.some((f) => !/LineString$/.test(f.geometry.type))
    )
      throw new Error("Corridor accepts only lines; filter geometryType first");
    shape = await buffered(geometry, input.radiusMeters, tolerance, tick);
  } else throw new Error("Unknown shape kind");
  signal.throwIfAborted();
  return output(
    shape
      ? [
          {
            ...shape,
            properties: {
              kind: input.kind,
              areaM2: area(shape),
              radiusMeters: input.radiusMeters ?? null,
            },
          },
        ]
      : [],
    { kind: input.kind, sourceFeatures: source?.features.length ?? 0 },
    [
      "Constructed geometry; it is not an observed boundary. A corridor's radiusMeters is its half-width.",
      ...notes.slice(0, 1),
    ],
  );
}
