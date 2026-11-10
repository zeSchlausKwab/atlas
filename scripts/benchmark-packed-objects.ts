/** Compare identical query IDs, compressed reads and local timings before/after repacking. */
import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  objectCatalog,
  objectRecords,
  readObjects,
} from "../packages/objects/src/index";
const args = process.argv.slice(2);
if (args.length < 3 || !["monaco", "vienna"].includes(args[0]!))
  throw new Error(
    "Usage: bun scripts/benchmark-packed-objects.ts monaco|vienna OLD.atlas NEW.atlas",
  );
const c = args[0]!;
const tag =
  c === "monaco"
    ? { key: "natural", value: "coastline" }
    : { key: "amenity", value: "bench" };
const bounds =
  c === "monaco"
    ? [7.408583, 43.483817, 7.595671, 43.75293]
    : [16.39, 48.2, 16.43, 48.23];
const results = [];
let expected: string[] | undefined;
for (const path of args.slice(1)) {
  const reads: string[] = [];
  const start = performance.now();
  const r = await new AtlasReader(new FileSource(Bun.file(path)), (e) =>
    reads.push(e.key),
  ).open();
  const cat = await objectCatalog(r),
    initialBytes = r.bytesRead;
  const t = performance.now();
  const ids = [];
  for await (const row of objectRecords(r, { tag })) ids.push(row.id);
  ids.sort();
  if (expected) assert.deepEqual(ids, expected);
  else expected = ids;
  const query = {
    matched: ids.length,
    bytes: r.bytesRead - initialBytes,
    ms: performance.now() - t,
    pages: reads.length,
  };
  const before = r.bytesRead,
    gt = performance.now();
  let shapes = 0;
  for await (const f of readObjects(
    r,
    bounds as any,
    true,
    undefined,
    () => true,
    undefined,
    { tag },
  ))
    shapes++;
  results.push({
    path,
    bytes: Bun.file(path).size,
    count: cat.count,
    initialBytes,
    query,
    geometry: {
      shapes,
      bytes: r.bytesRead - before,
      ms: performance.now() - gt,
    },
    totalMs: performance.now() - start,
  });
  r.dispose();
}
console.log(JSON.stringify(results, null, 2));
