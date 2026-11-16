import difference from "@turf/difference";
import intersects from "@turf/boolean-intersects";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import {
  MAP_LAYERS,
  project,
  tileLayer,
  type Block,
  type Manifest,
  type MapLayer,
} from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import { inside } from "../../offline/src/geometry";
export type Coverage = Feature<Polygon | MultiPolygon>;
export type Channel = MapLayer | "labels" | "boundaries";
export interface CompositionSource {
  id: string;
  manifest: Manifest;
  enabled: boolean;
  layers: MapLayer[];
  labels: boolean;
  boundaries?: boolean;
}
export interface CoveragePart {
  source: string;
  channel: Channel;
  coverage: Coverage;
}
export function rectangle(
  w: number,
  n: number,
  e: number,
  s: number,
): Coverage {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, n],
          [e, n],
          [e, s],
          [w, s],
          [w, n],
        ],
      ],
    },
  };
}
export function coverageOf(manifest: Manifest): Coverage {
  const [w, s, e, n] = manifest.bounds;
  const ring = (
    manifest.selection?.polygon ?? [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ]
  ).map((p) => project(p[0]!, p[1]!));
  if (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1])
    ring.push(ring[0]!);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
export function polygonsOf(coverage: Coverage) {
  return coverage.geometry.type === "Polygon"
    ? [coverage.geometry.coordinates]
    : coverage.geometry.coordinates;
}
export function coverageBounds(
  coverage: Coverage,
): [number, number, number, number] {
  const points = polygonsOf(coverage).flat(2);
  return [
    Math.min(...points.map((p) => p[0]!)),
    Math.min(...points.map((p) => p[1]!)),
    Math.max(...points.map((p) => p[0]!)),
    Math.max(...points.map((p) => p[1]!)),
  ];
}
export function contains(coverage: Coverage, point: [number, number]) {
  return polygonsOf(coverage).some(
    (rings) =>
      inside(point, rings[0]! as [number, number][]) &&
      !rings.slice(1).some((r) => inside(point, r as [number, number][])),
  );
}
/** First source owns each selected channel inside its advertised polygon. Other
 * channels pass through. Empty water is authoritative; it is not missing data. */
export function planComposition(
  sources: readonly CompositionSource[],
  zoom: number,
): CoveragePart[] {
  const result: CoveragePart[] = [];
  for (const channel of [...MAP_LAYERS, "labels", "boundaries"] as Channel[]) {
    const claimed: Coverage[] = [];
    for (const source of sources) {
      if (!source.enabled || zoom < source.manifest.minZoom) continue;
      const has =
        channel === "boundaries"
          ? source.boundaries &&
            source.manifest.capabilities.includes("boundary-rendering")
          : channel === "labels"
            ? source.labels &&
              source.manifest.capabilities.includes("map-labels")
            : source.layers.includes(channel) &&
              (source.manifest.tileLayers ?? MAP_LAYERS).includes(channel);
      if (!has) continue;
      const whole = coverageOf(source.manifest);
      const coverage = claimed.length
        ? difference({
            type: "FeatureCollection",
            features: [whole, ...claimed],
          })
        : whole;
      if (coverage) result.push({ source: source.id, channel, coverage });
      claimed.push(whole);
    }
  }
  return result;
}
export function clipArrays(coverage: Coverage) {
  const polygons = polygonsOf(coverage);
  return {
    coordinates: new Float64Array(polygons.flat(3)),
    rings: new Uint32Array(polygons.flat().map((r) => r.length)),
    polygons: new Uint32Array(polygons.map((p) => p.length)),
  };
}
/** Keeps the original reader's snapshot/cache identity and skips blocks whose
 * entire cell is hidden by higher-priority coverage. Payloads stay immutable. */
export class CoveredTiles {
  parts = new Map<Channel, Coverage>();
  constructor(readonly reader: AtlasReader) {}
  private filter(blocks: Block[]) {
    return blocks.filter((b) => {
      const layer = tileLayer(b.key);
      const n = 2 ** b.z!;
      const cell = rectangle(
        b.x! / n,
        b.y! / n,
        (b.x! + 1) / n,
        (b.y! + 1) / n,
      );
      return (layer ? [this.parts.get(layer)] : [...this.parts.values()]).some(
        (p) => p && intersects(p, cell),
      );
    });
  }
  tilesCached(...args: Parameters<AtlasReader["tilesCached"]>) {
    const r = this.reader.tilesCached(...args);
    return { complete: r.complete, blocks: this.filter(r.blocks) };
  }
  async tiles(...args: Parameters<AtlasReader["tiles"]>) {
    return this.filter(await this.reader.tiles(...args));
  }
  block(key: string) {
    return this.reader.block(key);
  }
}
