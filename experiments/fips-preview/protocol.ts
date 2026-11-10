/** Private, temporary preview interface. This is not a NAP domain. */
export const MAX_PENDING_BLOBS = 32;
export const ACTIVE_TRANSFERS = 8;
export const TRANSFER_ATTEMPTS = 2;
export const TRANSFER_RETRY_DELAY_MS = 750;

export interface PreviewConfig {
  seedUrls: string[];
  providerPeerId: string;
  map: {
    name: string;
    rootHash: string;
    size: number;
    chunkBytes: number;
    descriptor?: unknown;
  };
  timeoutMs?: number;
}

/** Includes a full accepted queue plus the transport's existing retry budget. */
export function blobRequestTimeoutMs(config: Pick<PreviewConfig, 'timeoutMs'>): number {
  return Math.ceil(MAX_PENDING_BLOBS / ACTIVE_TRANSFERS) *
    ((config.timeoutMs ?? 30000) * TRANSFER_ATTEMPTS + TRANSFER_RETRY_DELAY_MS * (TRANSFER_ATTEMPTS - 1)) + 10000;
}

export interface PreviewStats {
  requests: number;
  networkRequests: number;
  retries: number;
  fipsBytes: number;
  verifiedBlobs: number;
  cacheHits: number;
  errors: number;
  cancelledRequests: number;
  pending: number;
  activeTransfers: number;
  queuedTransfers: number;
}

export interface PreviewStatus {
  state: 'starting' | 'ready' | 'error' | 'closed';
  error?: string;
  peerId?: string;
  providerPeerId: string;
  seedUrls: string[];
  map: PreviewConfig['map'];
  connectedPeers: number;
  requestTimeoutMs: number;
  stats: PreviewStats;
}

export function parsePreviewConfig(value: unknown): PreviewConfig {
  if (!value || typeof value !== 'object') throw new Error('Missing preview FIPS configuration');
  const config = value as PreviewConfig;
  if (!/^(02|03)[a-f0-9]{64}$/.test(config.providerPeerId))
    throw new Error('providerPeerId must be a compressed FIPS public key (66 hex characters)');
  if (!Array.isArray(config.seedUrls) || !config.seedUrls.length || config.seedUrls.length > 4)
    throw new Error('Configure one to four FIPS WebSocket seeds');
  const seedUrls = config.seedUrls.map((value) => {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('Invalid FIPS WebSocket seed');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Unencrypted preview seeds must be loopback');
    return url.href;
  });
  const map = config.map;
  if (!map || typeof map.name !== 'string' || !/^[a-f0-9]{64}$/.test(map.rootHash) ||
      !Number.isSafeInteger(map.size) || map.size <= 0 ||
      !Number.isSafeInteger(map.chunkBytes) || map.chunkBytes < 16384 || map.chunkBytes > 2 * 1024 ** 2)
    throw new Error('Invalid pinned Atlas map configuration');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000))
    throw new Error('Preview timeout must be between 1 and 60 seconds');
  return { seedUrls, providerPeerId: config.providerPeerId, map, timeoutMs: config.timeoutMs ?? 30000 };
}
