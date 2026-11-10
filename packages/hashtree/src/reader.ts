import { decodeTreeNode, LinkType, toHex } from '@hashtree/core';
import { RemoteSource } from '../../format/src/remote-source';
import { sha256, type Block } from '../../format/src/index';
import type { BlockStore } from '../../format/src/store';
import { httpUrl, mapReference } from '../../format/src/urls';
import {
  FANOUT,
  MAX_BLOB_BYTES,
  parseTree,
  parseFipsProviders,
  type TreeOffer,
  type FipsProvider,
} from './offer';
/** Immutable public Hashtree bytes, independent of delivery transport.
 * Provider failures never become a permanent negative cache. Every blob is verified. */
export class HashtreeReader extends RemoteSource {
  readonly tree: TreeOffer;
  networkBytes = 0;
  requests = 0;
  failovers = 0;
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  constructor(
    url: string,
    tree: TreeOffer,
    api: string | undefined,
    private options: {
      store?: BlockStore;
      offline?: () => boolean;
      memoryBytes?: number;
      /** Per-blob transport deadline, including time spent in an adapter's queue. Defaults to 10 seconds. */
      requestTimeoutMs?: number;
      /** Replaces all advertised providers; failures and misses never fall back to HTTP. */
      fetchBlob: (hash: string, signal: AbortSignal) => Promise<Uint8Array | null>;
    },
  ) {
    super(url, api);
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    )
      throw new Error('Invalid Hashtree request timeout');
    this.tree = parseTree(tree, tree.bytes, !!options.fetchBlob);
    if (url.startsWith('htree:')) mapReference(url, undefined, this.tree.root);
  }
  addProviders(providers: string[]) {
    this.tree.providers = [
      ...new Set([...this.tree.providers, ...providers.map((p) => httpUrl(p).replace(/\/$/, ''))]),
    ].slice(0, 8);
  }
  addFipsProviders(providers: FipsProvider[]) {
    this.tree.fips = parseFipsProviders([...(this.tree.fips ?? []), ...providers].slice(0, 8));
  }
  clear() {
    this.cache.clear();
    this.cacheBytes = 0;
  }
  private descriptor(hash: string): Block {
    return { key: `hashtree/${hash}`, hash, offset: 0, length: 0, features: 0 };
  }
  private remember(hash: string, bytes: Uint8Array) {
    const old = this.cache.get(hash);
    if (old) this.cacheBytes -= old.length;
    this.cache.delete(hash);
    this.cache.set(hash, bytes);
    this.cacheBytes += bytes.length;
    const limit = this.options.memoryBytes ?? 4 * 1024 ** 2;
    while (this.cacheBytes > limit && this.cache.size) {
      const key = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(key)!.length;
      this.cache.delete(key);
    }
  }
  /** Adapters that already count individual provider failures can suppress double counting. */
  protected recordBlobFailure(_error: unknown) {
    this.failovers++;
  }
  private async blob(hash: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cached = this.cache.get(hash);
    if (cached) {
      this.remember(hash, cached);
      return cached;
    }
    const saved = await this.options.store?.get('hashtree-v1', this.descriptor(hash));
    if (saved && saved.length <= MAX_BLOB_BYTES && (await sha256(saved)) === hash) {
      this.remember(hash, saved);
      return saved;
    }
    if (this.options.offline?.()) throw new Error(`Missing cached Hashtree blob ${hash}`);
    this.requests++;
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 10000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let bytes: Uint8Array;
    try {
      const received = await this.options.fetchBlob(hash, requestSignal);
      requestSignal.throwIfAborted();
      if (!received) throw new Error('Blob unavailable');
      if (received.length > MAX_BLOB_BYTES) throw new Error('Oversized blob');
      this.networkBytes += received.length;
      if ((await sha256(received)) !== hash) throw new Error('Blob hash mismatch');
      requestSignal.throwIfAborted();
      bytes = received;
    } catch (error) {
      // Caller cancellation is not a failed provider attempt. A transport deadline is.
      signal?.throwIfAborted();
      this.recordBlobFailure(error);
      throw error;
    }
    this.remember(hash, bytes);
    await this.options.store?.put('hashtree-v1', this.descriptor(hash), bytes);
    return bytes;
  }

  async read(start: number, end: number, signal?: AbortSignal) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.tree.bytes ||
      end - start > 64 * 1024 ** 2
    )
      throw new Error('Invalid Hashtree byte range');
    const output = new Uint8Array(end - start);
    if (!output.length) return output;
    let visits = 0;
    const walk = async (
      hash: string,
      size: number,
      at: number,
      type: number,
      depth: number,
    ): Promise<void> => {
      if (at >= end || at + size <= start) return;
      if (++visits > 10000 || depth > 16) throw new Error('Hashtree traversal budget exceeded');
      const bytes = await this.blob(hash, signal);
      if (type === LinkType.Blob) {
        if (bytes.length !== size) throw new Error('Hashtree leaf length mismatch');
        const from = Math.max(start, at),
          to = Math.min(end, at + size);
        output.set(bytes.subarray(from - at, to - at), from - start);
        return;
      }
      const node = decodeTreeNode(bytes);
      if (node.type !== LinkType.File || !node.links.length || node.links.length > FANOUT)
        throw new Error('Unsupported or oversized Hashtree file node');
      let total = 0;
      for (const link of node.links) {
        if (
          !(link.hash instanceof Uint8Array) ||
          link.hash.length !== 32 ||
          link.key ||
          link.name !== undefined ||
          ![LinkType.Blob, LinkType.File].includes(link.type) ||
          !Number.isSafeInteger(link.size) ||
          link.size <= 0
        )
          throw new Error('Invalid Hashtree file link');
        total += link.size;
        if (!Number.isSafeInteger(total) || total > size)
          throw new Error('Hashtree subtree length mismatch');
      }
      if (total !== size) throw new Error('Hashtree subtree length mismatch');
      let offset = at;
      for (const link of node.links) {
        await walk(toHex(link.hash), link.size, offset, link.type, depth + 1);
        offset += link.size;
      }
    };
    await walk(
      this.tree.root,
      this.tree.bytes,
      0,
      this.tree.bytes <= this.tree.chunkBytes ? LinkType.Blob : LinkType.File,
      0,
    );
    return output;
  }
}
