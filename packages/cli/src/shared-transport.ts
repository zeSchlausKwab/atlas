import { AtlasReader, FileSource } from "../../format/src/reader";
import type { TransportMetadata } from "../../format/src/index";
import {
  planPreparation,
  type PackageSelection,
} from "../../provisioning/src/selection";
import type { DiskWriter } from "./disk-writer";

/** Copy immutable cells from one compiled graph; never regenerate local edge IDs. */
export async function copyTransport(
  writer: DiskWriter,
  input: string,
  selection: PackageSelection,
): Promise<TransportMetadata> {
  const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
  try {
    const source = reader.index.manifest;
    if (!source.transport)
      throw new Error("Shared source has no transport graph");
    const plan = await planPreparation(reader, {
      ...selection,
      snapshot: source.snapshot,
      minZoom: source.minZoom,
      maxZoom: source.maxZoom,
      layers: [],
      featureKinds: [],
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
    });
    const profiles: TransportMetadata["profiles"] = {};
    for (const mode of selection.profiles)
      profiles[mode] = {
        ...source.transport.profiles[mode]!,
        count: 0,
        nodes: 0,
        segments: 0,
        turns: 0,
      };
    for (const block of plan.blocks) {
      const bytes = await reader.block(block.key);
      const mode = selection.profiles.find((mode) =>
        block.key.startsWith(profiles[mode]!.prefix + "/"),
      )!;
      const profile = profiles[mode]!,
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (
        new TextDecoder().decode(bytes.subarray(0, 4)) !==
        profile.codec.toUpperCase()
      )
        throw new Error("Shared transport requires RCL2/RCL3 cells");
      profile.count++;
      profile.nodes += view.getUint32(20, true);
      profile.segments += view.getUint32(24, true);
      profile.turns += view.getUint32(28, true);
      await writer.add({ key: block.key, bytes, features: block.features });
      reader.cache.delete(block.key);
    }
    return {
      version: 1,
      federation: source.transport.federation,
      profiles,
      statistics: "cell-records",
      graphSnapshot: source.transport.graphSnapshot ?? source.snapshot,
    };
  } finally {
    reader.dispose();
  }
}
