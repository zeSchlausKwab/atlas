import { parsePreviewConfig } from './protocol';

export function configFromDescriptor(value: unknown, name = 'Atlas map', chunkBytes?: number) {
  if (!value || typeof value !== 'object') throw new Error('Invalid Atlas FIPS descriptor');
  const descriptor = value as Record<string, unknown>;
  if (descriptor.type !== 'atlas-fips' || descriptor.version !== 1)
    throw new Error('Expected an atlas-fips version 1 descriptor');
  return parsePreviewConfig({
    seedUrls: descriptor.seedUrls,
    providerPeerId: descriptor.peerId,
    map: {
      name, rootHash: descriptor.root, size: descriptor.bytes,
      // The original preview descriptor predates this field and used 64 KiB leaves.
      chunkBytes: chunkBytes ?? descriptor.chunkBytes ?? 65536,
    },
    timeoutMs: 30000,
  });
}

if (import.meta.main) {
  const [path, name, chunkBytes] = process.argv.slice(2);
  if (!path) throw new Error('Usage: bun config-from-descriptor.ts DESCRIPTOR_JSON [MAP_NAME] [CHUNK_BYTES]');
  const config = configFromDescriptor(await Bun.file(path).json(), name, chunkBytes ? Number(chunkBytes) : undefined);
  console.log(JSON.stringify(config, null, 2));
}
