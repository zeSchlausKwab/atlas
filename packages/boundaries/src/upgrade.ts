import { AtlasReader } from "../../format/src/reader";
import { sha256 } from "../../format/src/index";
import { StreamWriter } from "../../cli/src/stream-writer";
import { BoundaryWriter } from "./build";
import { boundaryRecords, boundaryFeature, hasBoundaries } from "./index";
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
/** Repack unchanged compressed blocks; append boundary data, never rewrite the source archive. */
export async function upgradeBoundaries(
  reader: AtlasReader,
  source: AtlasReader,
  output: string,
  signal: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  const m = reader.index.manifest;
  if (!hasBoundaries(source))
    throw new Error("Boundary source has no administrative data");
  if (m.source.sha256 !== source.index.manifest.source.sha256)
    throw new Error(
      "Boundary source must come from the exact same source snapshot",
    );
  const region = extent(reader);
  if (
    difference({
      type: "FeatureCollection",
      features: [region, extent(source)],
    })
  )
    throw new Error("Boundary source does not cover the target archive");
  if (await Bun.file(output).exists())
    throw new Error("Choose a new output path; archives are immutable");
  const writer = await new StreamWriter(output, Number.MAX_SAFE_INTEGER).open();
  try {
    let copied = 0,
      last = 0;
    for await (const b of reader.iterateBlocks()) {
      signal.throwIfAborted();
      if (b.key.startsWith("boundaries/")) continue;
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
    const boundaries = new BoundaryWriter(writer);
    for await (const row of boundaryRecords(
      source,
      m.bounds,
      signal,
      progress,
    )) {
      const f = await boundaryFeature(source, row);
      if (booleanIntersects(f, region))
        await boundaries.add({
          ...f,
          properties: { ...f.properties, boundaryRefs: row.relatedIds },
        });
    }
    await boundaries.finish();
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
            "boundaries" as const,
          ]),
        ],
        capabilities: [
          ...new Set([
            ...m.capabilities,
            "administrative-boundaries",
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
          "Administrative polygons retain complete source rings and explicit label/admin-centre links. Missing/incomplete source relations are omitted; parent/child hierarchy is not inferred.",
        ],
      },
      undefined,
      (stage, n, total) => {
        signal.throwIfAborted();
        progress(`${stage} · ${n}/${total}`);
      },
    );
    return { bytes, boundaries: boundaries.count, previousSnapshot: snapshot };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}
