/** Regression probe for Britain's sea, island, inland water and optional patch integrity.
 * bun scripts/verify-britain-water.ts URL_OR_FILE.atlas [ORIGINAL.atlas]
 */
import { strict as assert } from "node:assert";
import {
  AtlasReader,
  FileSource,
  HttpSource,
} from "../packages/format/src/reader";
import { project } from "../packages/format/src/index";
import { coversWater } from "./lib/water-probe";
const path = process.argv[2];
if (!path)
  throw Error(
    "Usage: bun scripts/verify-britain-water.ts URL_OR_FILE.atlas [ORIGINAL.atlas]",
  );
const reader = await new AtlasReader(
  /^https?:/.test(path) ? new HttpSource(path) : new FileSource(Bun.file(path)),
).open();
const probes: {
  name: string;
  point: [number, number];
  water: boolean;
  minZoom?: number;
}[] = [
  { name: "North Sea", point: [1.8, 54.2], water: true },
  { name: "Irish Sea", point: [-4.8, 53.5], water: true },
  { name: "Outer Hebrides sea", point: [-7.6, 57.7], water: true },
  { name: "London land", point: [-0.14, 51.52], water: false },
  { name: "Isle of Man land", point: [-4.54, 54.23], water: false, minZoom: 6 },
  { name: "Lewis island land", point: [-6.6, 58.1], water: false, minZoom: 6 },
  {
    name: "Lough Neagh inland lake",
    point: [-6.4, 54.65],
    water: true,
    minZoom: 8,
  },
];
let checks = 0;
for (const z of [4, 6, 8, 10, 14, 16])
  for (const p of probes) {
    if (z < (p.minZoom ?? 0)) continue;
    const [x, y] = project(...p.point).map((v) => Math.floor(v * 2 ** z));
    const blocks = await reader.tiles(z, x!, x!, y!, y!, ["water"]);
    let water = false;
    for (const b of blocks)
      water ||= coversWater(await reader.block(b.key), p.point, z, x!, y!);
    assert.equal(water, p.water, `${p.name} water coverage at z${z}`);
    checks++;
  }
let unchangedPages = 0;
if (process.argv[3]) {
  const old = await new AtlasReader(
    new FileSource(Bun.file(process.argv[3])),
  ).open();
  assert.deepEqual(
    reader.index.blocks,
    old.index.blocks,
    "Root operations unchanged",
  );
  assert.deepEqual(
    reader.index.manifest.transport,
    old.index.manifest.transport,
    "Graph identity unchanged",
  );
  assert.deepEqual(
    reader.index.manifest.capabilities,
    old.index.manifest.capabilities,
    "Capabilities unchanged",
  );
  const pages = new Map(reader.index.pages.map((p) => [p.key, p]));
  for (const p of old.index.pages)
    if (p.prefix !== "tile/water") {
      const after = pages.get(p.key);
      assert.ok(after);
      assert.equal(after.hash, p.hash, `Unchanged directory: ${p.key}`);
      assert.equal(after.count, p.count);
      unchangedPages++;
    }
  // The patch preserves the complete original data region, including root and
  // every paged payload. Streaming hashes detect even unsampled copy damage.
  const length =
    old.index.pages[0]?.offset ??
    old.index.header.fileLength - old.index.header.payloadOffset;
  async function digest(file: string, offset: number) {
    const hash = new Bun.CryptoHasher("sha256");
    const source = Bun.file(file);
    for (let at = 0; at < length; at += 8 * 1024 ** 2) {
      const end = Math.min(length, at + 8 * 1024 ** 2);
      const chunk = await source.slice(offset + at, offset + end).bytes();
      assert.equal(chunk.length, end - at, "Complete integrity-check read");
      hash.update(chunk);
      if (end % 1024 ** 3 === 0 || end === length)
        console.error(`Verified payload bytes: ${end}/${length}`);
    }
    return hash.digest("hex");
  }
  assert.equal(
    await digest(path, reader.index.header.payloadOffset),
    await digest(process.argv[3], old.index.header.payloadOffset),
    "All original data payload bytes unchanged",
  );
  old.dispose();
}
console.log(
  JSON.stringify(
    {
      snapshot: reader.index.manifest.snapshot,
      bytes: reader.index.header.fileLength,
      waterCoverageChecks: checks,
      unchangedDirectoryPages: unchangedPages,
      rangeBytesRead: reader.bytesRead,
    },
    null,
    2,
  ),
);
reader.dispose();
