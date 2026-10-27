import { mkdtemp, rm } from "node:fs/promises";
import { buildTreeIndex, IndexedTree } from "../packages/hashtree/src/build";
import { HashtreeSource } from "../packages/hashtree/src/source";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
const file = process.argv[2] ?? "data/liechtenstein.atlas",
  work = await mkdtemp("/tmp/atlas-tree-benchmark-");
const original = await new AtlasReader(new FileSource(Bun.file(file))).open();
const keys: string[] = [];
for await (const b of original.iterateBlocks()) {
  if (
    (b.key.startsWith("tile/buildings/16/") || b.key.startsWith("labels/")) &&
    b.length < 50000
  )
    keys.push(b.key);
  if (keys.length >= 30) break;
}
original.dispose();
const results = [];
try {
  for (const chunkBytes of [32768, 65536, 262144, 2097152]) {
    const path = `${work}/${chunkBytes}.sqlite`,
      meta = await buildTreeIndex(file, path, { chunkBytes }),
      index = IndexedTree.open(path);
    const host = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const b = await index.get(new URL(req.url).pathname.slice(1));
        return b
          ? new Response(new Uint8Array(b))
          : new Response(null, { status: 404 });
      },
    });
    try {
      const transport = new HashtreeSource(host.url.href, {
        version: 1,
        root: meta.root,
        bytes: meta.bytes,
        chunkBytes,
        providers: [host.url.origin],
      });
      const reader = await new AtlasReader(transport).open(),
        startupBytes = transport.networkBytes;
      for (const key of keys) await reader.block(key);
      const coldBytes = transport.networkBytes,
        coldRequests = transport.requests;
      for (const key of keys) await reader.block(key);
      results.push({
        chunkKiB: chunkBytes / 1024,
        startupBytes,
        logicalBytes: reader.bytesRead,
        networkBytes: coldBytes,
        requests: coldRequests,
        replayBytes: transport.networkBytes - coldBytes,
        indexDiskBytes: Bun.file(path).size,
      });
      reader.dispose();
    } finally {
      host.stop(true);
      index.close();
    }
  }
  console.log(
    JSON.stringify({ file, payloads: keys.length, results }, null, 2),
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
