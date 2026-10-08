import { AtlasReader, FileSource } from "../../format/src/reader";
import { MAP_LAYERS, sha256 } from "../../format/src/index";
import { splitTile } from "../../format/src/tiles";
import { DiskWriter } from "./disk-writer";
/** Migrate existing geometry without repeating import or changing any tile records. */
export async function splitPackageLayers(
  input: string,
  output: string,
  maxBytes: number,
  progress: (s: string) => void = () => {},
) {
  const file = Bun.file(input),
    reader = await new AtlasReader(new FileSource(file)).open();
  if (reader.index.manifest.tileLayers)
    throw new Error("Package already has independent map layers");
  const writer = await new DiskWriter(output, maxBytes).open();
  let tiles = 0,
    parts = 0;
  for (const b of await reader.allBlocks()) {
    if (b.key.startsWith("tile/")) {
      for (const part of splitTile(await reader.block(b.key))) {
        await writer.add({
          key: `tile/${part.layer}/${b.z}/${b.x}/${b.y}`,
          z: b.z,
          x: b.x,
          y: b.y,
          features: part.features,
          bytes: part.bytes,
        });
        parts++;
      }
      reader.cache.delete(b.key);
      if (++tiles % 10000 === 0)
        progress(
          `Split ${tiles.toLocaleString()} tiles into ${parts.toLocaleString()} layer blocks…`,
        );
    } else {
      const start = reader.index.header.payloadOffset + b.offset,
        bytes = await reader.source.read(start, start + b.length);
      if ((await sha256(bytes)) !== b.hash)
        throw new Error(`Integrity check failed: ${b.key}`);
      await writer.add({ ...b, bytes });
    }
  }
  const { snapshot, ...manifest } = reader.index.manifest;
  const bytes = await writer.finish({
    ...manifest,
    tileLayers: [...MAP_LAYERS],
  });
  return {
    file: output,
    bytes,
    tiles,
    layerBlocks: parts,
    parentSnapshot: snapshot,
  };
}
