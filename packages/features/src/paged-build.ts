import { project } from "../../format/src/index";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { decodeFeatures, type MapFeature, type Bounds } from "./index";
import {
  FEATURE_PAGE_TARGET,
  MAX_FEATURE_PAGE,
  featurePageKey,
  featureJSON,
  geometryHash,
  featureCatalog,
  type FeaturePage,
} from "./pages";

/** Small independent attribute/geometry pages inside the same archive. */
export class PagedFeatureWriter {
  private ordinal = 0;
  constructor(private writer: BlockWriter) {}
  async cell(
    key: string,
    features: Iterable<MapFeature> | AsyncIterable<MapFeature>,
    signal?: AbortSignal,
  ) {
    const pages: FeaturePage[] = [];
    let batch: MapFeature[] = [],
      size = 0;
    const flush = async () => {
      if (!batch.length) return;
      signal?.throwIfAborted();
      // Nearby features tend to be stored together; catalog bounds prune entire pages.
      const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
      const rows = [];
      for (const f of batch) {
        box[0] = Math.min(box[0], f.bbox[0]);
        box[1] = Math.min(box[1], f.bbox[1]);
        box[2] = Math.max(box[2], f.bbox[2]);
        box[3] = Math.max(box[3], f.bbox[3]);
        const { geometry, ...row } = f;
        rows.push({ ...row, geometryHash: await geometryHash(geometry) });
      }
      const attributes = featurePageKey("attributes", this.ordinal),
        geometry = featurePageKey("geometry", this.ordinal++);
      const a = featureJSON({
        schema: "feature-attributes-v2",
        features: rows,
      });
      const g = featureJSON({
        schema: "feature-geometry-v2",
        features: batch.map((f) => ({ id: f.id, geometry: f.geometry })),
      });
      if (a.length > MAX_FEATURE_PAGE || g.length > MAX_FEATURE_PAGE)
        throw new Error("A source feature exceeds the 4 MiB page limit");
      await this.writer.add({
        key: attributes,
        bytes: a,
        features: batch.length,
      });
      await this.writer.add({
        key: geometry,
        bytes: g,
        features: batch.length,
      });
      pages.push({ attributes, geometry, bounds: box, count: batch.length });
      batch = [];
      size = 0;
      if (pages.length > 10000)
        throw new Error("Feature cell catalog exceeds 10,000 pages");
    };
    const spatialKey = (f: MapFeature) => {
      const [x, y] = project(
        (f.bbox[0] + f.bbox[2]) / 2,
        (f.bbox[1] + f.bbox[3]) / 2,
      );
      let k = 0;
      const a = Math.floor(x * 65536),
        b = Math.floor(y * 65536);
      for (let bit = 0; bit < 16; bit++)
        k +=
          ((a >>> bit) & 1) * 2 ** (2 * bit) +
          ((b >>> bit) & 1) * 2 ** (2 * bit + 1);
      return k;
    };
    const input = Array.isArray(features)
      ? features
          .map((f) => ({ f, k: spatialKey(f) }))
          .sort((a, b) => a.k - b.k || a.f.id.localeCompare(b.f.id))
          .map((v) => v.f)
      : features;
    for await (const f of input) {
      const bytes = featureJSON({ schema: "features-v1", features: [f] });
      decodeFeatures(bytes);
      if (
        batch.length &&
        (batch.length >= 128 || size + bytes.length > FEATURE_PAGE_TARGET)
      )
        await flush();
      batch.push(f);
      size += bytes.length;
    }
    await flush();
    if (pages.length) {
      const bytes = featureJSON({ schema: "features-paged-v2", pages });
      featureCatalog(bytes);
      await this.writer.add({
        key,
        bytes,
        features: pages.reduce((n, p) => n + p.count, 0),
      });
    }
  }
}
