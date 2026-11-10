import { httpUrl } from '../../format/src/urls';
export const HASH = /^[a-f0-9]{64}$/;
export const CHUNK_BYTES = 64 * 1024;
export const FANOUT = 128;
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;
export interface FipsProvider {
  /** Compressed transport public key; distinct from the Nostr publisher key. */
  peerId: string;
  seedUrls: string[];
  /** Standard Hashtree TCP/FIPS service when omitted. */
  servicePort?: number;
  /** Absent means that this provider does not advertise server operations. */
  rpcPort?: number;
}
export function parseFipsProviders(value: unknown): FipsProvider[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid FIPS providers');
  const port = (value: unknown): number => {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
      throw new Error('Invalid FIPS service port');
    return value as number;
  };
  const providers: FipsProvider[] = [];
  for (const raw of value) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.peerId !== 'string' ||
      !/^(02|03)[a-f0-9]{64}$/.test(raw.peerId) ||
      !Array.isArray(raw.seedUrls) ||
      !raw.seedUrls.length ||
      raw.seedUrls.length > 8
    )
      throw new Error('Invalid FIPS provider');
    const seedUrls = [
      ...new Set<string>(
        raw.seedUrls.map((seed: unknown) => {
          if (typeof seed !== 'string' || seed.length > 2048)
            throw new Error('Invalid FIPS seed URL');
          const u = new URL(seed);
          if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash)
            throw new Error('Invalid FIPS seed URL');
          return u.href;
        }),
      ),
    ];
    const provider: FipsProvider = {
      peerId: raw.peerId,
      seedUrls,
      servicePort: raw.servicePort === undefined ? 39018 : port(raw.servicePort),
      ...(raw.rpcPort !== undefined ? { rpcPort: port(raw.rpcPort) } : {}),
    };
    const existing = providers.find(
      (p) =>
        p.peerId === provider.peerId &&
        p.servicePort === provider.servicePort &&
        p.rpcPort === provider.rpcPort,
    );
    if (existing) {
      existing.seedUrls = [...new Set([...existing.seedUrls, ...seedUrls])].slice(0, 8);
    } else providers.push(provider);
  }
  return providers;
}
export interface TreeOffer {
  version: 1;
  root: string;
  bytes: number;
  chunkBytes: number;
  providers: string[];
  fips?: FipsProvider[];
}
export function parseTree(value: unknown, bytes: number, allowNoProviders = false): TreeOffer {
  const v = value as TreeOffer;
  if (
    !v ||
    v.version !== 1 ||
    !HASH.test(v.root) ||
    v.bytes !== bytes ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    !Number.isInteger(v.chunkBytes) ||
    v.chunkBytes < 16384 ||
    v.chunkBytes > MAX_BLOB_BYTES ||
    !Array.isArray(v.providers) ||
    v.providers.length > 8
  )
    throw new Error('Invalid Hashtree offer');
  const fips = v.fips === undefined ? undefined : parseFipsProviders(v.fips);
  if (!allowNoProviders && !v.providers.length && !fips?.length)
    throw new Error('Invalid Hashtree offer');
  return {
    version: 1,
    root: v.root,
    bytes,
    chunkBytes: v.chunkBytes,
    providers: [...new Set(v.providers.map((p) => httpUrl(p).replace(/\/$/, '')))],
    ...(fips?.length ? { fips } : {}),
  };
}
