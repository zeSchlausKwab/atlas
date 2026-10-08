import { decodePlaces } from "../packages/labels/src/places";
import { tileRecords } from "../packages/format/src/tiles";
import { tileLayer } from "../packages/format/src/index";
import { decodeFeatures } from "../packages/features/src/index";
import { decodeLabels } from "../packages/labels/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
const file = process.argv[2] ?? "data/vienna-plus.atlas";
const reader = await new AtlasReader(new FileSource(Bun.file(file))).open();
const levels: Record<string, number> = {};
const addresses = new Map<string, number>();
const layerCounts: Record<string, number> = {},
  layerBytes: Record<string, number> = {};
let maxFeatures = 0,
  maxPoints = 0,
  checked = 0;
for (const b of await reader.allBlocks()) {
  const bytes = await reader.block(b.key);
  if (b.key.startsWith("tile/")) {
    const address = `${b.z}/${b.x}/${b.y}`,
      layer = tileLayer(b.key) ?? "combined";
    if (!addresses.has(address)) levels[b.z!] = (levels[b.z!] ?? 0) + 1;
    addresses.set(address, (addresses.get(address) ?? 0) + b.features);
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
    layerBytes[layer] = (layerBytes[layer] ?? 0) + b.length;
    let count = 0,
      points = 0;
    for (const record of tileRecords(bytes)) {
      count++;
      points += record.pointCount;
      if (layer !== "combined" && record.layer !== layer)
        throw new Error(`Mixed tile layer ${b.key}`);
    }
    if (count !== b.features) throw new Error(`Invalid tile count ${b.key}`);
    maxFeatures = Math.max(maxFeatures, count);
    maxPoints = Math.max(maxPoints, points);
  }
  if (b.key.startsWith("features/") && b.key !== "features/geojson")
    decodeFeatures(bytes);
  if (b.key === "labels/places") decodePlaces(bytes);
  else if (b.key.startsWith("labels/")) decodeLabels(bytes);
  reader.cache.delete(b.key);
  if (++checked % 20000 === 0) console.log(`${checked} blocks verified…`);
}
const m = reader.index.manifest;
for (let z = m.minZoom; z <= m.maxZoom; z++)
  if (!levels[z]) throw new Error(`Zoom ${z} is empty`);
if (process.argv[3]) {
  const previous = await new AtlasReader(
    new FileSource(Bun.file(process.argv[3])),
  ).open();
  const original = await previous.allBlocks(),
    current = new Map((await reader.allBlocks()).map((b) => [b.key, b]));
  const oldTiles = original.filter((b) => b.key.startsWith("tile/"));
  if (oldTiles.length !== addresses.size)
    throw new Error("Tile address count changed");
  for (const b of original) {
    if (b.key.startsWith("tile/")) {
      if (addresses.get(`${b.z}/${b.x}/${b.y}`) !== b.features)
        throw new Error(`Tile feature count changed: ${b.key}`);
    } else if (current.get(b.key)?.hash !== b.hash)
      throw new Error(`Non-map payload changed: ${b.key}`);
  }
  console.log(
    "Original tile addresses and feature counts preserved; all non-map payload hashes unchanged.",
  );
}
const result = {
  file,
  bytes: reader.index.header.fileLength,
  snapshot: m.snapshot,
  blocks: checked,
  zoomCounts: levels,
  layerCounts,
  layerBytes,
  uniqueTileAddresses: addresses.size,
  maxTileFeatures: maxFeatures,
  maxTilePoints: maxPoints,
  allStoredHashesVerified: true,
};
console.log(JSON.stringify(result, null, 2));
await Bun.write(`${file}.verification.json`, JSON.stringify(result, null, 2));
