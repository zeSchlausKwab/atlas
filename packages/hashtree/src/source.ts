import { decodeTreeNode, LinkType, toHex } from "@hashtree/core";
import { HttpSource } from "../../format/src/reader";
import { sha256, type Block } from "../../format/src/index";
import type { BlockStore } from "../../format/src/store";
import { httpUrl, mapReference } from "../../format/src/urls";
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
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Invalid FIPS providers");
  const port = (value: unknown): number => {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
      throw new Error("Invalid FIPS service port");
    return value as number;
  };
  const providers: FipsProvider[] = [];
  for (const raw of value) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.peerId !== "string" ||
      !/^(02|03)[a-f0-9]{64}$/.test(raw.peerId) ||
      !Array.isArray(raw.seedUrls) ||
      !raw.seedUrls.length ||
      raw.seedUrls.length > 8
    )
      throw new Error("Invalid FIPS provider");
    const seedUrls = [
      ...new Set<string>(
        raw.seedUrls.map((seed: unknown) => {
          if (typeof seed !== "string" || seed.length > 2048)
            throw new Error("Invalid FIPS seed URL");
          const u = new URL(seed);
          if (
            !["ws:", "wss:"].includes(u.protocol) ||
            u.username ||
            u.password ||
            u.hash
          )
            throw new Error("Invalid FIPS seed URL");
          return u.href;
        }),
      ),
    ];
    const provider: FipsProvider = {
      peerId: raw.peerId,
      seedUrls,
      servicePort:
        raw.servicePort === undefined ? 39018 : port(raw.servicePort),
      ...(raw.rpcPort !== undefined ? { rpcPort: port(raw.rpcPort) } : {}),
    };
    const existing = providers.find(
      (p) =>
        p.peerId === provider.peerId &&
        p.servicePort === provider.servicePort &&
        p.rpcPort === provider.rpcPort,
    );
    if (existing) {
      existing.seedUrls = [
        ...new Set([...existing.seedUrls, ...seedUrls]),
      ].slice(0, 8);
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
    v.providers.length > 8
  )
    throw new Error("Invalid Hashtree offer");
  const fips = v.fips === undefined ? undefined : parseFipsProviders(v.fips);
  if (!allowNoProviders && !v.providers.length && !fips?.length)
    throw new Error("Invalid Hashtree offer");
  return {
    version: 1,
    root: v.root,
    bytes,
    chunkBytes: v.chunkBytes,
    providers: [
      ...new Set(v.providers.map((p) => httpUrl(p).replace(/\/$/, ""))),
    ],
    ...(fips?.length ? { fips } : {}),
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
/** Immutable public Hashtree bytes, independent of delivery transport.
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
      /** Per-blob transport deadline, including time spent in an adapter's queue. Defaults to 10 seconds. */
      requestTimeoutMs?: number;
      /** FIPS is preferred whenever advertised. HTTP is used only if explicitly selected,
       * allowed as fallback, or the offer is an older HTTP-only publication. */
      transport?: "fips" | "http";
      allowHttpFallback?: boolean;
      fetchFipsBlob?: (
        hash: string,
        providers: FipsProvider[],
        signal: AbortSignal,
      ) => Promise<Uint8Array | null>;
      /** Replaces all advertised providers; failures and misses never fall back to HTTP. */
      fetchBlob?: (
        hash: string,
        signal: AbortSignal,
      ) => Promise<Uint8Array | null>;
    } = {},
  ) {
    super(url, api);
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs <= 0)
    )
      throw new Error("Invalid Hashtree request timeout");
    if (
      options.transport !== undefined &&
      !["fips", "http"].includes(options.transport)
    )
      throw new Error("Invalid Hashtree transport selection");
    this.tree = parseTree(tree, tree.bytes, !!options.fetchBlob);
    if (url.startsWith("htree:")) mapReference(url, undefined, this.tree.root);
  }
  addProviders(providers: string[]) {
    this.tree.providers = [
      ...new Set([
        ...this.tree.providers,
        ...providers.map((p) => httpUrl(p).replace(/\/$/, "")),
      ]),
    ].slice(0, 8);
  }
  addFipsProviders(providers: FipsProvider[]) {
    this.tree.fips = parseFipsProviders(
      [...(this.tree.fips ?? []), ...providers].slice(0, 8),
    );
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
    const preferFips =
      this.options.transport === "fips" ||
      (this.options.transport !== "http" && !!this.tree.fips?.length);
    const attempts: Array<
      { kind: "custom" } | { kind: "fips" } | { kind: "http"; url: string }
    > = this.options.fetchBlob
      ? [{ kind: "custom" }]
      : [
          ...(preferFips ? [{ kind: "fips" } as const] : []),
          ...(!preferFips || this.options.allowHttpFallback === true
            ? this.tree.providers.map((url) => ({ kind: "http" as const, url }))
            : []),
        ];
    if (!attempts.length)
      throw new Error("No provider for the selected Hashtree transport");
    for (const provider of attempts) {
      signal?.throwIfAborted();
      try {
        this.requests++;
        const timeout = AbortSignal.timeout(
          this.options.requestTimeoutMs ?? 10000,
        );
        const requestSignal = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;
        let bytes: Uint8Array | null;
        if (provider.kind === "custom") {
          bytes = await this.options.fetchBlob!(hash, requestSignal);
        } else if (provider.kind === "fips") {
          if (!this.options.fetchFipsBlob || !this.tree.fips?.length)
            throw new Error("FIPS transport is unavailable for this map");
          bytes = await this.options.fetchFipsBlob(
            hash,
            this.tree.fips,
            requestSignal,
          );
        } else {
          bytes = await boundedResponse(
            await fetch(`${provider.url}/${hash}`, {
              signal: requestSignal,
              cache: "no-store",
              credentials: "omit",
              redirect: "error",
            }),
            requestSignal,
          );
        }
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
