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
    for (const object of oceanObjects(data, sourceHash)) {
      signal.throwIfAborted();
      await ow.add(object);
    }
    ow.report.limitations.push(
      "Ocean polygons use a separately fingerprinted source. Polygon edges include artificial provider splits and clipping; physical coastline comes from natural=coastline source ways.",
    );
    return await ow.finish(progress);
  } finally {
    ow.close();
  }
}

/** IDs include the clipped geometry: separate clips cannot conflict under one provider hash. */
export function* oceanObjects(
  data: FeatureCollection<Polygon | MultiPolygon>,
  sourceHash: string,
): Generator<import("./model").SourceObject> {
  if (!/^[a-f0-9]{64}$/.test(sourceHash))
    throw new Error("Invalid ocean source fingerprint");
  for (const f of data.features) {
    if (!["Polygon", "MultiPolygon"].includes(f.geometry?.type))
      throw new Error("Expected assembled ocean polygons");
    const geometryHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(f.geometry))
      .digest("hex");
    yield {
      id: `external/ocean/${sourceHash}-${geometryHash}`,
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
    };
  }
}
