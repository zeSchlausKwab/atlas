import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { AtlasReader } from "../../format/src/reader";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { ObjectWriter } from "./build";
import {
  hasObjects,
  objectCatalog,
  objectRecords,
  objectGeometry,
  objectTopology,
} from "./index";
/** Ocean polygon edges include provider splits and clipping. Never advertise them as physical coastlines. */
export async function writeOceanObjects(
  reader: AtlasReader,
  writer: BlockWriter,
  data: FeatureCollection<Polygon | MultiPolygon>,
  sourceHash: string,
  signal: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash))
    throw new Error("Invalid ocean source fingerprint");
  const ow = new ObjectWriter(writer);
  let copied = 0;
  try {
    if (hasObjects(reader)) {
      ow.report.profile = (await objectCatalog(reader)).report.profile;
      for await (const row of objectRecords(
        reader,
        { includeDependencies: true },
        signal,
        progress,
      )) {
        await ow.add({
          id: row.id,
          tags: row.tags,
          geometry: (await objectGeometry(reader, row, signal)) ?? null,
          geometryStatus: row.geometryStatus,
          dependencyOnly: row.dependencyOnly,
          ...(await objectTopology(reader, row, signal)),
        });
        if (++copied % 1000 === 0)
          progress(`Retaining ${copied} source objects`);
      }
    } else ow.report.profile = "derived-surfaces";
    for (let i = 0; i < data.features.length; i++) {
      signal.throwIfAborted();
      const f = data.features[i]!;
      if (!["Polygon", "MultiPolygon"].includes(f.geometry?.type))
        throw new Error("Expected assembled ocean polygons");
      await ow.add({
        id: `external/ocean/${sourceHash}-${i}`,
        tags: {
          natural: "water",
          water: "ocean",
          "atlas:surface": "sea",
          "atlas:source_sha256": sourceHash,
          "atlas:edge_semantics":
            "provider splits and extraction edges; not physical coastline",
        },
        geometry: f.geometry,
        geometryStatus: "complete",
      });
    }
    ow.report.limitations.push(
      "Ocean polygons use a separately fingerprinted source. Polygon edges include artificial provider splits and clipping; physical coastline comes from natural=coastline source ways.",
    );
    return await ow.finish();
  } finally {
    ow.close();
  }
}
