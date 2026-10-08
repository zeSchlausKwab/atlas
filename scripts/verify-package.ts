import { decodeLabels } from "../packages/labels/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
const file = process.argv[2] ?? "data/vienna-plus.atlas";
const reader = await new AtlasReader(new FileSource(Bun.file(file))).open();
const levels: Record<string, number> = {};
let maxFeatures = 0,
  maxPoints = 0,
  checked = 0;
for (const b of await reader.allBlocks()) {
  const bytes = await reader.block(b.key);
  if (b.z !== undefined) {
    levels[b.z] = (levels[b.z] ?? 0) + 1;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "TIL1")
      throw new Error(`Invalid tile magic ${b.key}`);
    const count = v.getUint32(4, true);
    if (count !== b.features || count > 500000)
      throw new Error(`Invalid tile count ${b.key}`);
    let o = 8,
      points = 0;
    for (let f = 0; f < count; f++) {
      const cls = v.getUint8(o),
        kind = v.getUint8(o + 1),
        parts = v.getUint16(o + 2, true);
      o += 4;
      if (cls > 7 || kind < 1 || kind > 3) throw new Error("Bad feature");
      for (let p = 0; p < parts; p++) {
        const n = v.getUint32(o, true);
        points += n;
        o += 4 + n * 4;
      }
    }
    if (o !== bytes.length || points > 3000000)
      throw new Error(`Invalid tile length/points ${b.key}`);
    maxFeatures = Math.max(maxFeatures, count);
    maxPoints = Math.max(maxPoints, points);
  }
  if (b.key.startsWith("labels/")) decodeLabels(bytes);
  reader.cache.delete(b.key);
  if (++checked % 20000 === 0) console.log(`${checked} blocks verified…`);
}
const m = reader.index.manifest;
for (let z = m.minZoom; z <= m.maxZoom; z++)
  if (!levels[z]) throw new Error(`Zoom ${z} is empty`);
const result = {
  file,
  bytes: reader.index.header.fileLength,
  snapshot: m.snapshot,
  blocks: checked,
  zoomCounts: levels,
  maxTileFeatures: maxFeatures,
  maxTilePoints: maxPoints,
  allStoredHashesVerified: true,
};
console.log(JSON.stringify(result, null, 2));
await Bun.write(`${file}.verification.json`, JSON.stringify(result, null, 2));
