import { sha256 } from '../../format/src/index';
import { HashtreeReader } from './reader';
import { MAX_BLOB_BYTES, type TreeOffer, type FipsProvider } from './offer';
import type { BlockStore } from '../../format/src/store';
export * from './offer';
async function boundedResponse(response: Response, signal?: AbortSignal) {
  if (!response.ok || !response.body) throw new Error(`Blob HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_BLOB_BYTES)
    throw new Error('Oversized blob');
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > MAX_BLOB_BYTES) throw new Error('Oversized blob');
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}
/** Standalone HTTP/FIPS adapters; opaque napplets import HashtreeReader instead. */
export class HashtreeSource extends HashtreeReader {
  constructor(
    url: string,
    tree: TreeOffer,
    api?: string,
    options: {
      store?: BlockStore;
      offline?: () => boolean;
      memoryBytes?: number;
      /** Per-blob transport deadline, including time spent in an adapter's queue. Defaults to 10 seconds. */
      requestTimeoutMs?: number;
      /** FIPS is preferred whenever advertised. HTTP is used only if explicitly selected,
       * allowed as fallback, or the offer is an older HTTP-only publication. */
      transport?: 'fips' | 'http';
      allowHttpFallback?: boolean;
      fetchFipsBlob?: (
        hash: string,
        providers: FipsProvider[],
        signal: AbortSignal,
      ) => Promise<Uint8Array | null>;
      /** Replaces all advertised providers; failures and misses never fall back to HTTP. */
      fetchBlob?: (hash: string, signal: AbortSignal) => Promise<Uint8Array | null>;
    } = {},
  ) {
    if (options.transport !== undefined && !['fips', 'http'].includes(options.transport))
      throw new Error('Invalid Hashtree transport selection');
    super(url, tree, api, {
      ...options,
      fetchBlob:
        options.fetchBlob ??
        (async (hash, signal) => {
          const preferFips =
            options.transport === 'fips' ||
            (options.transport !== 'http' && !!this.tree.fips?.length);
          const errors: string[] = [];
          if (preferFips) {
            try {
              if (!options.fetchFipsBlob || !this.tree.fips?.length)
                throw new Error('FIPS transport is unavailable for this map');
              const bytes = await options.fetchFipsBlob(hash, this.tree.fips, signal);
              if (!bytes) throw new Error('Blob unavailable');
              if (bytes.length > MAX_BLOB_BYTES || (await sha256(bytes)) !== hash)
                throw new Error('Blob hash mismatch or oversized blob');
              return bytes;
            } catch (error) {
              signal.throwIfAborted();
              errors.push(String(error));
              this.failovers++;
            }
          }
          if (!preferFips || options.allowHttpFallback)
            for (const provider of this.tree.providers) {
              try {
                const bytes = await boundedResponse(
                  await fetch(`${provider}/${hash}`, {
                    signal,
                    cache: 'no-store',
                    credentials: 'omit',
                    redirect: 'error',
                  }),
                  signal,
                );
                if ((await sha256(bytes)) !== hash) throw new Error('Blob hash mismatch');
                return bytes;
              } catch (error) {
                signal.throwIfAborted();
                errors.push(String(error));
                this.failovers++;
              }
            }
          throw new TypeError(
            `Hashtree network fetch failed (${errors.join('; ') || 'No provider for the selected Hashtree transport'})`,
          );
        }),
    });
  }
}
