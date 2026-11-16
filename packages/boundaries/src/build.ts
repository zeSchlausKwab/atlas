import { includesAdminLevel } from "./selection";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { areaAnchor } from "../../geocoding/src/anchor";
import {
  geometryBounds,
  validateFeatures,
  type MapFeature,
} from "../../features/src/index";
import {
  BOUNDARY_ROOT,
  boundaryKey,
  validateBoundary,
  type BoundaryRecord,
  type BoundaryPage,
} from "./index";
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** One geometry per source object, bounded metadata pages, no replication into display cells. */
export class BoundaryWriter {
  private ids = new Set<string>();
  private records: BoundaryRecord[] = [];
  private pages: BoundaryPage[] = [];
  count = 0;
  constructor(
    private writer: BlockWriter,
    private maxAdminLevel?: number,
  ) {}
  async add(source: Feature) {
    if (source.properties?.tags?.boundary !== "administrative") return;
    if (!includesAdminLevel(source.properties.tags, this.maxAdminLevel)) return;
    if (!["Polygon", "MultiPolygon"].includes(source.geometry.type)) return;
    const geometry = source.geometry as Polygon | MultiPolygon,
      id = String(source.id ?? source.properties?.id);
    const feature: MapFeature = {
      type: "Feature",
      id,
      geometry,
      bbox: geometryBounds(geometry),
      properties: {
        id,
        name: String(
          source.properties?.name ?? source.properties?.tags?.name ?? "",
        ),
        kind: "boundaries",
        tags: source.properties!.tags,
      },
    };
    const data = { schema: "features-v1", features: [feature] };
    validateFeatures(data);
    validateBoundary(feature);
    if (this.ids.has(id)) throw new Error(`Duplicate boundary ID ${id}`);
    this.ids.add(id);
    const key = boundaryKey("geometry", this.count++);
    await this.writer.add({ key, bytes: encode(data), features: 1 });
    const coordinates = areaAnchor(
      geometry.type === "Polygon"
        ? ([geometry.coordinates] as [number, number][][][])
        : (geometry.coordinates as [number, number][][][]),
    );
    if (!coordinates)
      throw new Error(`Boundary ${id} has no valid surface anchor`);
    const record: BoundaryRecord = {
      id,
      name: feature.properties.name,
      tags: feature.properties.tags,
      bbox: feature.bbox,
      coordinates,
      relatedIds: source.properties?.boundaryRefs ?? [],
      geometry: key,
    };
    if (
      this.records.length &&
      (this.records.length >= 256 ||
        encode({
          schema: "boundary-records-v1",
          records: [...this.records, record],
        }).length >
          1024 ** 2)
    )
      await this.flush();
    this.records.push(record);
  }
  private async flush() {
    if (!this.records.length) return;
    const key = boundaryKey("records", this.pages.length),
      bbox: [number, number, number, number] = [
        Infinity,
        Infinity,
        -Infinity,
        -Infinity,
      ];
    for (const r of this.records) {
      bbox[0] = Math.min(bbox[0], r.bbox[0]);
      bbox[1] = Math.min(bbox[1], r.bbox[1]);
      bbox[2] = Math.max(bbox[2], r.bbox[2]);
      bbox[3] = Math.max(bbox[3], r.bbox[3]);
    }
    const bytes = encode({
      schema: "boundary-records-v1",
      records: this.records,
    });
    if (bytes.length > 1024 ** 2)
      throw new Error("One boundary metadata record exceeds 1 MiB");
    await this.writer.add({ key, bytes, features: this.records.length });
    this.pages.push({ key, bbox, count: this.records.length });
    this.records = [];
  }
  async finish() {
    await this.flush();
    await this.writer.add({
      key: BOUNDARY_ROOT,
      bytes: encode({
        schema: "boundaries-v1",
        count: this.count,
        pages: this.pages,
      }),
      features: this.count,
    });
  }
}
