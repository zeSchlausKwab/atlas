import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { toHex, sha256 } from '@hashtree/core';
// Load runtime dependencies before replacing the running preview.
await import('../fips-service.ts');
const [source, index] = process.argv.slice(2);
if (!source || !index) throw new Error('Expected Atlas source directory and read-only index');
const { IndexedTree } = await import(pathToFileURL(resolve(source, 'packages/hashtree/src/build.ts')).href);
const tree = IndexedTree.open(index);
try {
  await tree.assertUnchanged();
  const bytes = await tree.get(tree.info.root);
  if (!bytes || toHex(await sha256(bytes)) !== tree.info.root) throw new Error('Root verification failed');
  console.log(JSON.stringify({ root: tree.info.root, bytes: tree.info.bytes, chunkBytes: tree.info.chunkBytes }));
} finally {
  tree.close();
}
