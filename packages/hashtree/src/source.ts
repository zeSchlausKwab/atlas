import { decodeTreeNode, LinkType, toHex } from "@hashtree/core";
import { HttpSource } from "../../format/src/reader";
import { sha256, type Block } from "../../format/src/index";
import type { BlockStore } from "../../format/src/store";
import { httpUrl } from "../../format/src/urls";
export const HASH = /^[a-f0-9]{64}$/;
export const CHUNK_BYTES = 64 * 1024;
export const FANOUT = 128;
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;
export interface TreeOffer {
  version: 1;
  root: string;
  bytes: number;
  chunkBytes: number;
  providers: string[];
}
export function parseTree(
  value: unknown,
  bytes: number,
  allowNoProviders = false,
): TreeOffer {
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
    (!allowNoProviders && !v.providers.length) ||
    v.providers.length > 8
  )
    throw new Error("Invalid Hashtree offer");
  return {
    version: 1,
    root: v.root,
    bytes,
    chunkBytes: v.chunkBytes,
    providers: [
      ...new Set(v.providers.map((p) => httpUrl(p).replace(/\/$/, ""))),
    ],
  };
}
async function boundedResponse(response: Response, signal?: AbortSignal) {
  if (!response.ok || !response.body)
    throw new Error(`Blob HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_BLOB_BYTES)
    throw new Error("Oversized blob");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > MAX_BLOB_BYTES) throw new Error("Oversized blob");
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
/** Immutable public Hashtree bytes. HTTP identity is retained for existing tool APIs.
 * Provider failures never become a permanent negative cache. Every blob is verified. */
export class HashtreeSource extends HttpSource {
  readonly tree: TreeOffer;
  networkBytes = 0;
  requests = 0;
  failovers = 0;
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  constructor(
    url: string,
    tree: TreeOffer,
    api?: string,
    private options: {
      store?: BlockStore;
      offline?: () => boolean;
      memoryBytes?: number;
      /** Replaces HTTP providers; failures and misses never fall back to HTTP. */
      fetchBlob?: (
        hash: string,
        signal: AbortSignal,
      ) => Promise<Uint8Array | null>;
    } = {},
  ) {
    super(url, api);
    this.tree = parseTree(tree, tree.bytes, !!options.fetchBlob);
  }
  addProviders(providers: string[]) {
    this.tree.providers = [
      ...new Set([
        ...this.tree.providers,
        ...providers.map((p) => httpUrl(p).replace(/\/$/, "")),
      ]),
    ].slice(0, 8);
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
  private async blob(hash: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cached = this.cache.get(hash);
    if (cached) {
      this.remember(hash, cached);
      return cached;
    }
    const saved = await this.options.store?.get(
      "hashtree-v1",
      this.descriptor(hash),
    );
    if (
      saved &&
      saved.length <= MAX_BLOB_BYTES &&
      (await sha256(saved)) === hash
    ) {
      this.remember(hash, saved);
      return saved;
    }
    if (this.options.offline?.())
      throw new Error(`Missing cached Hashtree blob ${hash}`);
    const errors: string[] = [];
    const providers = this.options.fetchBlob
      ? [undefined]
      : this.tree.providers;
    for (const provider of providers) {
      signal?.throwIfAborted();
      try {
        this.requests++;
        const timeout = AbortSignal.timeout(10000);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;
        const bytes = this.options.fetchBlob
          ? await this.options.fetchBlob(hash, requestSignal)
          : await boundedResponse(
              await fetch(`${provider}/${hash}`, {
                signal: requestSignal,
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
              }),
              requestSignal,
            );
        requestSignal.throwIfAborted();
        if (!bytes) throw new Error("Blob unavailable");
        if (bytes.length > MAX_BLOB_BYTES) throw new Error("Oversized blob");
        this.networkBytes += bytes.length;
        if ((await sha256(bytes)) !== hash)
          throw new Error("Blob hash mismatch");
        signal?.throwIfAborted();
        this.remember(hash, bytes);
        await this.options.store?.put(
          "hashtree-v1",
          this.descriptor(hash),
          bytes,
        );
        return bytes;
      } catch (e) {
        signal?.throwIfAborted();
        this.failovers++;
        errors.push(String(e));
      }
    }
    throw new TypeError(`Hashtree network fetch failed (${errors.join("; ")})`);
  }
  override async read(start: number, end: number, signal?: AbortSignal) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.tree.bytes ||
      end - start > 64 * 1024 ** 2
    )
      throw new Error("Invalid Hashtree byte range");
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
      if (++visits > 10000 || depth > 16)
        throw new Error("Hashtree traversal budget exceeded");
      const bytes = await this.blob(hash, signal);
      if (type === LinkType.Blob) {
        if (bytes.length !== size)
          throw new Error("Hashtree leaf length mismatch");
        const from = Math.max(start, at),
          to = Math.min(end, at + size);
        output.set(bytes.subarray(from - at, to - at), from - start);
        return;
      }
      const node = decodeTreeNode(bytes);
      if (
        node.type !== LinkType.File ||
        !node.links.length ||
        node.links.length > FANOUT
      )
        throw new Error("Unsupported or oversized Hashtree file node");
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
          throw new Error("Invalid Hashtree file link");
        total += link.size;
        if (!Number.isSafeInteger(total) || total > size)
          throw new Error("Hashtree subtree length mismatch");
      }
      if (total !== size) throw new Error("Hashtree subtree length mismatch");
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
