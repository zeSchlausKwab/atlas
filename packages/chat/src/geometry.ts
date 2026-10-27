import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
export const MAX_DRAW_BYTES = 16 * 1024 ** 2;
export function validateDrawing(
  value: unknown,
): asserts value is FeatureCollection {
  const fc = value as FeatureCollection;
  if (
    !fc ||
    fc.type !== "FeatureCollection" ||
    !Array.isArray(fc.features) ||
    fc.features.length > 10000
  )
    throw new Error(
      "Drawing must be a FeatureCollection with at most 10,000 objects",
    );
  if (JSON.stringify(fc).length > MAX_DRAW_BYTES)
    throw new Error("Drawing exceeds 16 MiB");
  let points = 0;
  const position = (p: Position) => {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      !p.every(Number.isFinite) ||
      Math.abs(p[0]!) > 180 ||
      Math.abs(p[1]!) > 85 ||
      ++points > 250000
    )
      throw new Error("Invalid or oversized drawing coordinates");
  };
  const line = (p: Position[], min = 2) => {
    if (!Array.isArray(p) || p.length < min)
      throw new Error("Invalid drawing line");
    p.forEach(position);
  };
  const polygon = (rings: Position[][]) => {
    if (!Array.isArray(rings) || !rings.length)
      throw new Error("Invalid drawing polygon");
    for (const ring of rings) {
      line(ring, 4);
      if (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1])
        throw new Error("Polygon rings must be closed");
    }
  };
  for (const f of fc.features) {
    if (f?.type !== "Feature" || !f.geometry)
      throw new Error("Invalid drawing feature");
    const g = f.geometry;
    switch (g.type) {
      case "Point":
        position(g.coordinates);
        break;
      case "MultiPoint":
        if (!Array.isArray(g.coordinates)) throw new Error("Invalid points");
        g.coordinates.forEach(position);
        break;
      case "LineString":
        line(g.coordinates);
        break;
      case "MultiLineString":
        if (!Array.isArray(g.coordinates)) throw new Error("Invalid lines");
        g.coordinates.forEach((p) => line(p));
        break;
      case "Polygon":
        polygon(g.coordinates);
        break;
      case "MultiPolygon":
        if (!Array.isArray(g.coordinates)) throw new Error("Invalid polygons");
        g.coordinates.forEach(polygon);
        break;
      default:
        throw new Error("Unsupported drawing geometry");
    }
  }
}
export function drawingBounds(
  fc: FeatureCollection,
): [number, number, number, number] | null {
  const box: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  const visit = (p: unknown): void => {
    if (!Array.isArray(p)) return;
    if (typeof p[0] === "number") {
      box[0] = Math.min(box[0], p[0]);
      box[2] = Math.max(box[2], p[0]);
      box[1] = Math.min(box[1], p[1]);
      box[3] = Math.max(box[3], p[1]);
    } else p.forEach(visit);
  };
  for (const f of fc.features)
    if (f.geometry.type !== "GeometryCollection") visit(f.geometry.coordinates);
  return Number.isFinite(box[0]) ? box : null;
}
export function collection(
  geometry: Geometry,
  properties: Record<string, unknown> = {},
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry, properties }],
  };
}
export type ResultMeta = Record<string, unknown>;
export interface SavedGeometry {
  collection: FeatureCollection;
  meta: ResultMeta;
  expiresAt: number;
}
export class GeometryResults {
  private values = new Map<string, SavedGeometry>();
  private sweep() {
    for (const [key, v] of this.values)
      if (v.expiresAt < Date.now()) this.values.delete(key);
  }
  save(fc: FeatureCollection, meta: ResultMeta) {
    this.sweep();
    validateDrawing(fc);
    if (
      this.values.size >= 32 ||
      [...this.values.values()].reduce(
        (n, v) => n + JSON.stringify(v.collection).length,
        JSON.stringify(fc).length,
      ) >
        32 * 1024 ** 2
    )
      throw new Error(
        "Result geometry budget reached. Start a new chat to release results.",
      );
    const ref = "geo-" + crypto.randomUUID(),
      expiresAt = Date.now() + 30 * 60 * 1000;
    this.values.set(ref, {
      collection: structuredClone(fc),
      meta: structuredClone(meta),
      expiresAt,
    });
    return {
      result: ref,
      count: fc.features.length,
      bounds: drawingBounds(fc),
      expiresAt,
      ...meta,
    };
  }
  get(ref: string) {
    this.sweep();
    const value = this.values.get(ref);
    if (!value) throw new Error("Geometry result expired or is unknown");
    return structuredClone(value);
  }
  clear() {
    this.values.clear();
  }
}
