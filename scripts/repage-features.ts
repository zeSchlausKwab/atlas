/** Repack selectable features without reimporting PBF, rebuilding tiles, search or graphs. */
import { resolve } from "node:path";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { PagedFeatureWriter } from "../packages/features/src/paged-build";
import { readFeatureCell } from "../packages/features/src/pages";
import type { MapFeature } from "../packages/features/src/index";
export async function repageFeatures(
  input: string,
  output: string,
  progress = console.log,
) {
  if (resolve(input) === resolve(output))
    throw new Error("Choose a new output file; the source stays unchanged");
  if (await Bun.file(output).exists()) throw new Error("Output already exists");
  const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
  let writer: StreamWriter | undefined;
  let finished = false;
  try {
    const { snapshot: _snapshot, ...manifest } = reader.index.manifest;
    if (!manifest.capabilities.includes("feature-extraction"))
      throw new Error("Source has no feature extraction data");
    writer = await new StreamWriter(output, Number.MAX_SAFE_INTEGER).open();
    const features = new PagedFeatureWriter(writer);
    let completed = 0;
    for await (const block of reader.iterateBlocks()) {
      if (/^features\/(attributes|geometry)\//.test(block.key)) continue;
      if (
        /^features\/(buildings|water|railways|roads|land)\//.test(block.key)
      ) {
        async function* rows() {
          for await (const row of readFeatureCell(
            reader,
            block.key,
            [-180, -85, 180, 85],
          ))
            yield row as MapFeature;
        }
        // Legacy cells are already bounded by the reader. Sort each to cluster new pages spatially.
        const cell: MapFeature[] = [];
        for await (const row of rows()) cell.push(row);
        await features.cell(block.key, cell);
      } else {
        await writer.add({
          key: block.key,
          bytes: await reader.block(block.key),
          features: block.features,
          ...(block.z === undefined
            ? {}
            : { z: block.z, x: block.x, y: block.y }),
        });
      }
      reader.cache.delete(block.key);
      if (++completed % 500 === 0) progress(`Repacked ${completed} blocks`);
    }
    const size = await writer.finish({ ...manifest, featureSchema: 2 });
    finished = true;
    progress(`Wrote ${output}: ${size} bytes`);
    return size;
  } finally {
    reader.dispose();
    if (!finished) await writer?.abort();
  }
}
if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      "Usage: bun scripts/repage-features.ts INPUT.atlas OUTPUT.atlas",
    );
  await repageFeatures(input, output);
}
