import { AtlasReader, FileSource } from "../../packages/format/src/reader";
import { encodePackage } from "../../packages/format/src/writer";
import { buildFeatures } from "../../packages/features/src/compile";
import { AtlasEngine } from "../../packages/operations/src/index";
import lake from "../../plugins/lakes";
import type { Feature, Polygon } from "geojson";
export const polygon: [number, number][] = [[9,47],[9.2,47],[9.2,47.2],[9,47.2]];
const ring = (x: number, y: number, size: number) => [[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
export function water(id: number, size: number, tags = { water: "lake" }, hole = 0): Feature<Polygon> {
  return { type: "Feature", properties: { id: `way/${id}`, class: 1, name: `Lake ${id}`, tags: { natural: "water", ...tags } }, geometry: { type: "Polygon", coordinates: [ring(9.01,47.01,size), ...(hole ? [ring(9.02,47.02,hole)] : [])] } };
}
export async function pluginFixture(features: Feature[] = [water(1,.04),water(2,.1)]) {
  const cells = buildFeatures({ type: "FeatureCollection", features });
  const bytes = await encodePackage({ format: "atlas", version: 1, name: "Plugin fixture", source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test OSM" }, bounds: [9,47,9.2,47.2], minZoom: 0, maxZoom: 0, features: features.length, peaks: 0, places: [], featureZoom: 12, capabilities: ["feature-extraction"], limitations: [] }, [...cells].map(([key,features]) => ({ key, bytes: new TextEncoder().encode(JSON.stringify({ schema: "features-v1", features })) })), { paged: true });
  const reader = await new AtlasReader(new FileSource(new Blob([bytes]))).open(), engine = new AtlasEngine(reader);
  engine.registry.register(lake, "fixture-lake-v1");
  return { engine, reader, bytes, ref: { id: lake.descriptor.id, version: lake.descriptor.version, implementation: "fixture-lake-v1" } };
}
