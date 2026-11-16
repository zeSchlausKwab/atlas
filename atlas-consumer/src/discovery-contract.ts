import type { MapOffer } from '../../packages/format/src/catalog';
import type { ViewRecipe } from '../../packages/views/src/index';
import type { FipsRpcRequest } from '../../packages/fips/src/rpc';
import { relayUrl } from '../../packages/hashtree/src/announcement';
import type { FipsStats } from './vendor/fips-resource-client';
export type PreviewStats = FipsStats & { requests: number; pending: number };

/** Atlas-owned discovery configuration; relay hints remain subject to shell policy. */
export interface ConsumerConfig {
  publisher: string;
  relayUrls: string[];
  mapIds?: string[];
  timeoutMs?: number;
}
export interface ConsumerStatus {
  version: 2;
  state: 'discovering' | 'ready' | 'error' | 'closed';
  catalog: Array<{ key: string; offer: MapOffer; publisher: string }>;
  defaultView?: ViewRecipe;
  preferredMapIds: string[];
  discovery: {
    publishers: string[]; relayUrls: string[]; messages: string[];
    /** The current query completed without incomplete relay results. */
    ready: boolean;
    /** The query has finished; independently verified offers may be usable even when incomplete. */
    settled: boolean;
  };
  stats: PreviewStats;
  requestTimeoutMs: number;
  error?: string;
}
export type ConsumerRpcRequest = Omit<FipsRpcRequest, 'root'>;

export function parseConsumerConfig(value: unknown): ConsumerConfig {
  const c = value as ConsumerConfig;
  if (!c || typeof c !== 'object' || !/^[a-f0-9]{64}$/.test(c.publisher))
    throw new Error('Configure a trusted Nostr publisher public key (64 lowercase hex characters)');
  if (!Array.isArray(c.relayUrls) || !c.relayUrls.length || c.relayUrls.length > 4)
    throw new Error('Configure one to four discovery relays');
  const relayUrls = [
    ...new Set(
      c.relayUrls.map((value) => {
        if (typeof value !== 'string' || value.length > 2048)
          throw new Error('Invalid discovery relay');
        const url = new URL(relayUrl(value));
        if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
          throw new Error('Unencrypted discovery relays must be loopback');
        return url.href;
      }),
    ),
  ];
  if (
    c.mapIds !== undefined &&
    (!Array.isArray(c.mapIds) ||
      c.mapIds.length > 32 ||
      c.mapIds.some((id) => typeof id !== 'string' || !id.length || id.length > 200))
  )
    throw new Error('Invalid preferred map IDs');
  if (
    c.timeoutMs !== undefined &&
    (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 60000)
  )
    throw new Error('Preview timeout must be between 1 and 60 seconds');
  return {
    publisher: c.publisher,
    relayUrls,
    mapIds: [...new Set(c.mapIds ?? [])],
    timeoutMs: c.timeoutMs ?? 30000,
  };
}

export function consumerError(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(consumerError).join('; ')}`.slice(0, 1800);
  return (error instanceof Error ? error.message : String(error)).slice(0, 1800);
}
