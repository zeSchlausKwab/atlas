import { AtlasReader } from "../../format/src/reader";
import { sha256 } from "../../format/src/index";
import { StreamWriter } from "../../cli/src/stream-writer";
import { ObjectWriter } from "./build";
import {
  objectRecords,
  objectGeometry,
  objectTopology,
  hasObjects,
} from "./index";
import { LEGACY_FEATURE_KINDS } from "../../features/src/index";
import booleanIntersects from "@turf/boolean-intersects";
import difference from "@turf/difference";
import type { Feature, Polygon } from "geojson";
const extent = (r: AtlasReader): Feature<Polygon> => {
  const m = r.index.manifest,
    b = m.bounds,
    p = m.selection?.polygon ?? [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
    ];
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[...p, p[0]!]] },
  };
};
/** Repack unchanged compressed blocks; append source-object data, never rewrite the source archive. */
export async function upgradeObjects(
  reader: AtlasReader,
  source: AtlasReader,
  output: string,
  signal: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  const m = reader.index.manifest;
  if (!hasObjects(source))
    throw new Error("Source-object archive has no general source-object data");
  if (m.source.sha256 !== source.index.manifest.source.sha256)
    throw new Error(
      "Source-object archive must come from the exact same source snapshot",
    );
  const region = extent(reader);
  if (
    difference({
      type: "FeatureCollection",
      features: [region, extent(source)],
    })
  )
    throw new Error("Source-object archive does not cover the target archive");
  if (await Bun.file(output).exists())
    throw new Error("Choose a new output path; archives are immutable");
  const writer = await new StreamWriter(output, Number.MAX_SAFE_INTEGER).open();
  try {
    let copied = 0,
      last = 0;
    for await (const b of reader.iterateBlocks()) {
      signal.throwIfAborted();
      if (b.key.startsWith("objects/")) continue;
      const offset = reader.index.header.payloadOffset + b.offset,
        bytes = await reader.source.read(offset, offset + b.length, signal);
      if ((await sha256(bytes)) !== b.hash)
        throw new Error(`Source block checksum mismatch: ${b.key}`);
      await writer.add({ ...b, bytes }, { compress: false });
      copied += b.length;
      if (performance.now() - last > 1000) {
        progress(
          `Reusing compressed data · ${(copied / 1024 ** 3).toFixed(2)} / ${(reader.index.header.fileLength / 1024 ** 3).toFixed(2)} GiB`,
        );
        last = performance.now();
      }
    }
    const objects = new ObjectWriter(writer);
    try {
      objects.report.profile = "selected-objects";
      for await (const row of objectRecords(
        source,
        { bounds: m.bounds, includeDependencies: true, includeUnlocated: true },
        signal,
        progress,
      )) {
        const geometry = await objectGeometry(source, row, signal);
        if (geometry && !booleanIntersects(geometry, region)) continue;
        await objects.add({
          id: row.id,
          tags: row.tags,
          geometry: geometry ?? null,
          geometryStatus: row.geometryStatus,
          dependencyOnly: row.dependencyOnly,
          ...(await objectTopology(source, row, signal)),
        });
      }
      await objects.finish();
    } finally {
      objects.close();
    }
    const { snapshot, ...manifest } = m;
    const bytes = await writer.finish(
      {
        ...manifest,
        featureZoom: 12,
        featureKinds: [
          ...new Set([
            ...(m.featureKinds ??
              (m.capabilities.includes("feature-extraction")
                ? LEGACY_FEATURE_KINDS
                : [])),
            "objects" as const,
          ]),
        ],
        capabilities: [
          ...new Set([
            ...m.capabilities,
            "source-objects",
            "feature-extraction",
          ]),
        ],
        transport: m.transport
          ? {
              ...m.transport,
              graphSnapshot: m.transport.graphSnapshot ?? snapshot,
            }
          : undefined,
        limitations: [
          ...m.limitations,
          "Source objects preserve tags, geometry and ordered relationships independently of display categories. References may point outside this excerpt; incomplete geometry is explicit.",
        ],
      },
      undefined,
      (stage, n, total) => {
        signal.throwIfAborted();
        progress(`${stage} · ${n}/${total}`);
      },
    );
    return {
      bytes,
      objects: Object.values(objects.report.counts).reduce((a, b) => a + b, 0),
      previousSnapshot: snapshot,
    };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}
