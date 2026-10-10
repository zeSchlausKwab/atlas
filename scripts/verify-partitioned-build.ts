import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasGeocoder } from "../packages/geocoding/src/index";
import { preparePackage } from "../packages/provisioning/src/prepare";
import { tileRecords } from "../packages/format/src/tiles";
import { placesInView } from "../packages/labels/src/place-pages";
import { decodeLabels } from "../packages/labels/src/index";
import { selectedSearch } from "../packages/geocoding/src/selection";
import { mkdtemp, rm } from "node:fs/promises";
if (process.argv.length < 5)
  throw new Error(
    "Usage: bun run verify:partitioned-build NEW.atlas REGIONAL.atlas selection.json (Liechtenstein fixture)",
  );
const next = await new AtlasReader(
  new FileSource(Bun.file(process.argv[2]!)),
).open();
const ref = await new AtlasReader(
  new FileSource(Bun.file(process.argv[3]!)),
).open();
const selection = await Bun.file(process.argv[4]!).json();
const work = await mkdtemp("/tmp/atlas-parity-");
const out = work + "/selected.atlas";
await preparePackage(
  ref,
  { ...selection, snapshot: ref.index.manifest.snapshot },
  out,
  new AbortController().signal,
  () => {},
);
const expected = await new AtlasReader(new FileSource(Bun.file(out))).open();
const hashes = (b: Uint8Array) =>
  [...tileRecords(b)]
    .map((r) =>
      new Bun.CryptoHasher("sha256")
        .update(b.subarray(r.start, r.end))
        .digest("hex"),
    )
    .sort();
let tiles = 0,
  cells = 0,
  labelCount = 0;
const expectedBlocks = new Map(
  (await expected.allBlocks()).map((b) => [b.key, b]),
);
for await (const block of next.iterateBlocks()) {
  if (block.key.startsWith("tile/") || block.key.startsWith("routing/")) {
    assert(expectedBlocks.has(block.key), `Unexpected ${block.key}`);
    const a = await next.block(block.key),
      b = await expected.block(block.key);
    if (block.key.startsWith("tile/")) {
      assert.deepEqual(hashes(a), hashes(b), block.key);
      tiles++;
    } else {
      assert.deepEqual(a, b, block.key);
      cells++;
    }
  } else if (/^labels\/\d/.test(block.key)) {
    const data = decodeLabels(await next.block(block.key));
    labelCount += data.roads.length + data.pois.length;
  }
}
assert.equal(
  tiles,
  [...expectedBlocks.values()].filter((b) => b.key.startsWith("tile/")).length,
);
assert.equal(
  cells,
  [...expectedBlocks.values()].filter((b) => b.key.startsWith("routing/"))
    .length,
);
const a = new AtlasGeocoder(next),
  b = new AtlasGeocoder(expected);
for (const q of [
  "vaduz",
  "strasse",
  "museum",
  "bahnhof",
  "schule",
  "schloss",
]) {
  const r = await a.search(q),
    e = await b.search(q);
  assert.deepEqual(r.matches, e.matches, q);
  assert.equal(r.total, e.total);
}
for (const p of [
  [9.515, 47.139],
  [9.51, 47.11],
] as [number, number][])
  assert.deepEqual((await a.reverse(p)).match, (await b.reverse(p)).match);
assert.deepEqual(
  (await next.highestPeak()).peak,
  (await expected.highestPeak()).peak,
);
assert((await placesInView(next, [0.52, 0.34, 0.54, 0.36], 10)).length > 0);
assert(
  (await selectedSearch(next, selection.polygon, "locations")).records.length >
    0,
);
console.log(
  JSON.stringify({
    tiles,
    cells,
    labelCount,
    bytes: next.index.header.fileLength,
  }),
);
console.log(
  "PASS: all display records and routing cells agree with the regional pipeline; search, reverse, labels and peaks are usable.",
);
for (const r of [next, ref, expected]) r.dispose();
await rm(work, { force: true, recursive: true });
