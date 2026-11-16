/** Read-only snapshot export. Never changes an Atlas map or a running service. */
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  buildTreeIndex,
  IndexedTree,
} from "../../../packages/hashtree/src/build";
import { AtlasReader, FileSource } from "../../../packages/format/src/reader";
const [input, output] = Bun.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: bun apps/android/scripts/export-map.ts map.atlas output-directory",
  );
const out = resolve(output);
await mkdir(out, { recursive: true });
const file = resolve(input),
  index = resolve(out, "tree.sqlite");
const info = await buildTreeIndex(file, index);
const tree = IndexedTree.open(index);
try {
  await mkdir(resolve(out, "blobs"), { recursive: true });
  for (const { hash } of tree.db.query("SELECT hash FROM blobs").all() as {
    hash: string;
  }[]) {
    const bytes = await tree.get(hash);
    if (!bytes) throw new Error("Missing indexed blob");
    await Bun.write(resolve(out, "blobs", hash), bytes);
  }
  const reader = new AtlasReader(new FileSource(Bun.file(file)));
  await reader.open();
  const offer = {
    id: "native-demo",
    url: `htree://${info.root}`,
    bytes: info.bytes,
    manifest: { ...reader.index.manifest, places: [] },
    hashtree: {
      version: 1,
      root: info.root,
      bytes: info.bytes,
      chunkBytes: info.chunkBytes,
      providers: [],
    },
  };
  await Bun.write(resolve(out, "offers.json"), JSON.stringify([offer]));
  reader.dispose();
  console.log(
    JSON.stringify({
      root: info.root,
      bytes: info.bytes,
      blocks: info.blocks,
      output: out,
    }),
  );
} finally {
  tree.close();
}
