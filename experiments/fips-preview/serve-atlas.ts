import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { toHex, sha256 } from '@hashtree/core';
import { startAtlasFipsService } from './fips-service.ts';

const sourceRoot = process.env.ATLAS_SOURCE_ROOT;
const indexPath = process.env.ATLAS_INDEX_PATH;
const keyPath = process.env.ATLAS_FIPS_KEY_PATH;
if (!sourceRoot || !indexPath || !keyPath) {
  throw new Error('Set ATLAS_SOURCE_ROOT, ATLAS_INDEX_PATH and ATLAS_FIPS_KEY_PATH');
}
const seedUrls = (process.env.ATLAS_FIPS_SEEDS ?? 'wss://fips1.iris.to/fips,wss://fips2.iris.to/fips')
  .split(',').map(value => value.trim()).filter(Boolean);
const { IndexedTree } = await import(pathToFileURL(resolve(sourceRoot, 'packages/hashtree/src/build.ts')).href);
const tree = IndexedTree.open(indexPath);
await tree.assertUnchanged();
const rootBytes = await tree.get(tree.info.root);
if (!rootBytes || toHex(await sha256(rootBytes)) !== tree.info.root) throw new Error('Atlas root verification failed');
const service = await startAtlasFipsService({ keyPath, seedUrls,
  getBlob: hash => tree.get(toHex(hash)),
  onServed: request => console.log(JSON.stringify({ type: 'fips-blob', ...request })),
});
const descriptor = { type: 'atlas-fips', version: 1, peerId: service.peerId, seedUrls,
  root: tree.info.root, bytes: tree.info.bytes, chunkBytes: tree.info.chunkBytes, servicePort: 39018 };
console.log(JSON.stringify(descriptor));
if (process.env.ATLAS_FIPS_DESCRIPTOR_PATH) {
  await writeFile(process.env.ATLAS_FIPS_DESCRIPTOR_PATH, JSON.stringify(descriptor, null, 2) + '\n');
}
const metrics = setInterval(() => console.log(JSON.stringify({ type: 'fips-status', ...service.status() })), 10_000);
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  clearInterval(metrics);
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  await service.stop(); tree.close(); process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
