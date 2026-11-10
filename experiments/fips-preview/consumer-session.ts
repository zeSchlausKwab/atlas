import { verifyEvent, type Event } from 'nostr-tools/pure';
import { decodeTreeNode, LinkType, toHex } from '@hashtree/core';
import { FipsClient, FIPS_REQUEST_TIMEOUT_MS } from '../../packages/fips/src/client';
import { abortable, validateRpcRequest, type FipsRpcResponse } from '../../packages/fips/src/rpc';
import { MAP_KIND, parseAnnouncement, watchMaps } from '../../packages/hashtree/src/discovery';
import { FANOUT, HASH, MAX_BLOB_BYTES, parseFipsProviders } from '../../packages/hashtree/src/source';
import { VIEW_KIND, parseViewAnnouncement } from '../../packages/views/src/announcement';
import type { MapOffer } from '../../packages/format/src/catalog';
import { consumerError, parseConsumerConfig, type ConsumerConfig, type ConsumerRpcRequest,
  type ConsumerStatus, type PreviewStats } from './consumer-protocol';

type Client = Pick<FipsClient, 'fetchBlob' | 'request' | 'status' | 'stop'>;
type Entry = { offer: MapOffer; event: Event; abort: AbortController; expires: number };
type ProofLink = { type: LinkType; size: number; depth: number };
type RootProof = { bytes: number; chunkBytes: number; links: Map<string, ProofLink> };
const MAX_CACHE_BYTES = 32 * 1024 ** 2;
const MAX_PENDING = 128;
const newer = (next: Event, old?: Event) => !old || next.created_at > old.created_at ||
  (next.created_at === old.created_at && next.id < old.id);
const cancelled = () => new DOMException('Map request is no longer active', 'AbortError');

/** All networking and trust decisions live here, outside the opaque consumer iframe. */
export class ConsumerSession {
  readonly config: ConsumerConfig;
  private readonly client: Client;
  private readonly watch: typeof watchMaps;
  private readonly lifetime = new AbortController();
  private discovery?: AbortController;
  private generation = 0;
  private entries = new Map<string, Entry>();
  private revisions = new Map<string, Event>();
  private withdrawals = new Map<string, number>();
  private deleted = new Set<string>();
  private views = new Map<string, ReturnType<typeof parseViewAnnouncement> & { expires?: number }>();
  private viewRevisions = new Map<string, Event>();
  private listeners = new Set<(kind: 'catalog' | 'stats') => void>();
  // Membership outlives the byte LRU: a consumer may retain verified ancestors.
  private proofs = new Map<string, RootProof>();
  private proofLinks = 0;
  private rpcPins = new Map<string, string>();
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private error?: string;
  private messages: string[] = [];
  private pending = 0;
  private counters = { requests: 0, verifiedBlobs: 0, cacheHits: 0, errors: 0, cancelledRequests: 0 };
  private closing?: Promise<void>;

  constructor(config: ConsumerConfig, dependencies: { client?: Client; watch?: typeof watchMaps } = {}) {
    this.config = parseConsumerConfig(config);
    this.client = dependencies.client ?? new FipsClient({ timeoutMs: this.config.timeoutMs });
    this.watch = dependencies.watch ?? watchMaps;
  }
  subscribe(listener: (kind: 'catalog' | 'stats') => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(kind: 'catalog' | 'stats') { for (const listener of this.listeners) listener(kind); }
  stats(): PreviewStats {
    const transport = this.client.status();
    return { ...this.counters, networkRequests: transport.requests + transport.rpcRequests,
      retries: transport.retries, fipsBytes: transport.bytesReceived, pending: this.pending,
      activeTransfers: transport.activeTransfers, queuedTransfers: transport.queuedTransfers };
  }
  status(): ConsumerStatus {
    this.expire();
    const catalog = [...this.entries.values()].map(({ offer, event }) => ({
      key: `${event.pubkey}:${offer.id}@${offer.hashtree!.root}`, offer, publisher: event.pubkey,
    })).sort((a, b) => a.key.localeCompare(b.key));
    const roots = new Set(catalog.map((entry) => entry.offer.hashtree!.root));
    const view = [...this.views.values()].sort((a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id))
      .find((v) => v.recipe.sources.every((source) => roots.has(source.root)));
    return structuredClone({ version: 2, state: this.lifetime.signal.aborted ? 'closed' :
      catalog.length || this.ready ? 'ready' : this.error ? 'error' : 'discovering', catalog,
      ...(view ? { defaultView: view.recipe } : {}), preferredMapIds: this.config.mapIds ?? [],
      discovery: { publishers: [this.config.publisher], relayUrls: this.config.relayUrls, messages: this.messages, ready: this.ready },
      stats: this.stats(), requestTimeoutMs: FIPS_REQUEST_TIMEOUT_MS, ...(this.error ? { error: this.error } : {}) });
  }
  private report(message: string) {
    if (this.messages.at(-1) !== message) this.messages = [...this.messages, message.slice(0, 1000)].slice(-8);
    this.emit('catalog');
  }
  /** Reconnect discovery without resetting revision or deletion protection. */
  async refresh(): Promise<ConsumerStatus> {
    this.lifetime.signal.throwIfAborted();
    const generation = ++this.generation;
    this.discovery?.abort();
    const discovery = this.discovery = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, discovery.signal]);
    this.ready = false; this.error = undefined; this.messages = [];
    this.emit('catalog');
    let connected = 0;
    const live = () => !signal.aborted && generation === this.generation;
    await Promise.all(this.config.relayUrls.map(async (url) => {
      try {
        await this.watch(url, [this.config.publisher], (_offer, event) => {
          if (live()) this.acceptAnnouncement(event);
        }, signal, (message) => { if (live()) this.report(message); }, (view) => {
          if (live()) this.acceptView(view.event);
        }, {
          ready: () => { if (live()) { this.ready = true; this.emit('catalog'); } },
          deleted: (event) => { if (live()) this.acceptDeletion(event); },
          withdrawn: (_id, _publisher, event) => { if (live()) this.acceptDeletion(event); },
        });
        connected++;
      } catch (error) { if (live()) this.report(`${url}: ${consumerError(error)}`); }
    }));
    if (live() && !connected) { this.error = 'Discovery relays are unavailable. Retry discovery to reconnect.'; this.emit('catalog'); }
    return this.status();
  }
  acceptAnnouncement(raw: unknown): boolean {
    if (this.lifetime.signal.aborted) return false;
    let rejectedRevision: string | undefined;
    try {
      const { event, offer } = parseAnnouncement(raw);
      if (event.pubkey !== this.config.publisher || !offer.hashtree) return false;
      const address = `${event.pubkey}:${offer.id}`;
      if (!newer(event, this.revisions.get(address)) ||
          (this.withdrawals.get(address) ?? -1) >= event.created_at || this.deleted.has(`${event.pubkey}:${event.id}`)) return false;
      if (!this.revisions.has(address) && this.revisions.size >= 4096) return false;
      this.revisions.set(address, event); rejectedRevision = address;
      const fips = parseFipsProviders(offer.hashtree.fips);
      if (!fips.length) throw new Error('Signed map does not advertise FIPS providers');
      for (const provider of fips) {
        if (provider.servicePort !== 39018 || (provider.rpcPort !== undefined && provider.rpcPort !== 39019))
          throw new Error('Unsupported signed FIPS service port');
        for (const seed of provider.seedUrls) {
          const url = new URL(seed);
          if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
            throw new Error('Unencrypted FIPS seeds must be loopback');
        }
      }
      const root = offer.hashtree.root, proof = this.proofs.get(root);
      if (proof && (proof.bytes !== offer.bytes || proof.chunkBytes !== offer.hashtree.chunkBytes))
        throw new Error('Conflicting signed metadata for immutable root');
      const previousRoot = this.entries.get(address)?.offer.hashtree!.root;
      this.entries.get(address)?.abort.abort(cancelled());
      if (!proof) {
        if (this.proofLinks >= 1000000) throw new Error('Preview root membership limit reached');
        this.proofs.set(root, { bytes: offer.bytes, chunkBytes: offer.hashtree.chunkBytes,
          links: new Map([[root, { type: offer.bytes <= offer.hashtree.chunkBytes ? LinkType.Blob : LinkType.File,
            size: offer.bytes, depth: 0 }]]) });
        this.proofLinks++;
      }
      // Signed HTTP hints are intentionally absent from the consumer contract.
      const safe: MapOffer = { id: offer.id, url: `htree://${offer.hashtree.root}`, bytes: offer.bytes,
        manifest: offer.manifest, hashtree: { ...offer.hashtree, providers: [], fips } };
      this.entries.set(address, { offer: safe, event, abort: new AbortController(),
        expires: Number(event.tags.find((tag) => tag[0] === 'expiration')![1]) });
      if (previousRoot && previousRoot !== root) this.forgetUnusedRoot(previousRoot);
      this.error = undefined;
      rejectedRevision = undefined;
      this.scheduleExpiry(); this.emit('catalog');
      return true;
    } catch {
      // A newer valid signed revision supersedes an older offer even if its transport is unsupported.
      if (rejectedRevision) { this.remove(rejectedRevision); this.scheduleExpiry(); this.emit('catalog'); }
      return false;
    }
  }
  acceptView(raw: unknown): boolean {
    if (this.lifetime.signal.aborted) return false;
    try {
      const parsed = parseViewAnnouncement(raw, this.config.publisher), key = `view:${parsed.event.pubkey}:${parsed.recipe.id}`;
      if (!newer(parsed.event, this.viewRevisions.get(key)) ||
          (this.withdrawals.get(key) ?? -1) >= parsed.event.created_at ||
          this.deleted.has(`${parsed.event.pubkey}:${parsed.event.id}`) ||
          this.viewRevisions.size >= 128 && !this.viewRevisions.has(key)) return false;
      const expiration = parsed.event.tags.filter((tag) => tag[0] === 'expiration');
      const expires = expiration.length ? Number(expiration[0]![1]) : undefined;
      this.viewRevisions.set(key, parsed.event);
      if (expiration.length > 1 || expires !== undefined && (!Number.isSafeInteger(expires) || expires <= Date.now() / 1000)) {
        this.views.delete(key); this.scheduleExpiry(); this.emit('catalog'); return false;
      }
      this.views.set(key, { ...parsed, expires }); this.scheduleExpiry(); this.emit('catalog'); return true;
    } catch { return false; }
  }
  acceptDeletion(raw: unknown): boolean {
    if (this.lifetime.signal.aborted) return false;
    try {
      if (JSON.stringify(raw).length > 256 * 1024) return false;
      const event = JSON.parse(JSON.stringify(raw)) as Event;
      if (event.kind !== 5 || event.pubkey !== this.config.publisher || !verifyEvent(event) ||
          event.created_at > Math.floor(Date.now() / 1000) + 300) return false;
      for (const tag of event.tags) {
        const prefix = `${MAP_KIND}:${event.pubkey}:atlas/`;
        if (tag[0] === 'a' && tag[1]?.startsWith(prefix)) {
          const address = `${event.pubkey}:${tag[1].slice(prefix.length)}`;
          this.withdrawals.set(address, Math.max(event.created_at, this.withdrawals.get(address) ?? -1));
          const entry = this.entries.get(address);
          if (entry && entry.event.created_at <= event.created_at) this.remove(address);
        } else if (tag[0] === 'a' && tag[1]?.startsWith(`${VIEW_KIND}:${event.pubkey}:atlas-view/`)) {
          const address = `view:${event.pubkey}:${tag[1].slice(`${VIEW_KIND}:${event.pubkey}:atlas-view/`.length)}`;
          this.withdrawals.set(address, Math.max(event.created_at, this.withdrawals.get(address) ?? -1));
          const view = this.views.get(address);
          if (view && view.event.created_at <= event.created_at) this.views.delete(address);
        } else if (tag[0] === 'e' && HASH.test(tag[1] ?? '')) {
          this.deleted.add(`${event.pubkey}:${tag[1]}`);
          for (const [address, entry] of this.entries)
            if (entry.event.id === tag[1] && entry.event.created_at <= event.created_at) this.remove(address);
          for (const [address, view] of this.views)
            if (view.event.id === tag[1] && view.event.created_at <= event.created_at) this.views.delete(address);
        }
      }
      this.scheduleExpiry(); this.emit('catalog'); return true;
    } catch { return false; }
  }
  private remove(address: string) {
    const old = this.entries.get(address);
    if (!old) return;
    old.abort.abort(cancelled()); this.entries.delete(address);
    this.forgetUnusedRoot(old.offer.hashtree!.root);
  }
  private forgetUnusedRoot(root: string) {
    if (![...this.entries.values()].some((entry) => entry.offer.hashtree!.root === root)) {
      this.proofLinks -= this.proofs.get(root)?.links.size ?? 0; this.proofs.delete(root); this.rpcPins.delete(root);
      for (const [key, bytes] of this.cache) if (key.startsWith(`${root}:`)) {
        this.cacheBytes -= bytes.length; this.cache.delete(key);
      }
    }
  }
  private expire() {
    let changed = false;
    for (const [address, entry] of this.entries) if (entry.expires <= Date.now() / 1000) {
      this.remove(address); changed = true;
    }
    for (const [address, view] of this.views) if (view.expires !== undefined && view.expires <= Date.now() / 1000) {
      this.views.delete(address); changed = true;
    }
    if (changed) { this.scheduleExpiry(); this.emit('catalog'); }
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const deadlines = [...this.entries.values()].map((entry) => entry.expires)
      .concat([...this.views.values()].flatMap((view) => view.expires === undefined ? [] : [view.expires]));
    if (!deadlines.length) return;
    const next = Math.min(...deadlines);
    this.expiryTimer = setTimeout(() => { this.expire(); this.scheduleExpiry(); }, Math.min(2147483647, Math.max(1, next * 1000 - Date.now())));
  }
  private entry(root: string): Entry {
    this.lifetime.signal.throwIfAborted(); this.expire();
    if (typeof root !== 'string' || !HASH.test(root)) throw new Error('Invalid pinned map root');
    const entry = [...this.entries.values()].find((e) => e.offer.hashtree!.root === root);
    if (!entry) throw new Error('Map root is not in the active signed catalog');
    return entry;
  }
  private async run<T>(entry: Entry, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([this.lifetime.signal, entry.abort.signal, AbortSignal.timeout(FIPS_REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    if (this.pending >= MAX_PENDING) throw new Error('Preview request queue is full');
    this.pending++; this.counters.requests++; this.emit('stats');
    try {
      const result = await abortable(action(combined), combined);
      combined.throwIfAborted(); this.entry(entry.offer.hashtree!.root);
      return result;
    } catch (error) {
      if (combined.aborted) this.counters.cancelledRequests++; else this.counters.errors++;
      throw error;
    } finally { this.pending--; this.emit('stats'); }
  }
  async blob(hash: string, root: string, signal?: AbortSignal): Promise<Uint8Array> {
    const entry = this.entry(root);
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('Invalid blob hash');
    const proof = this.proofs.get(root)!, link = proof.links.get(hash);
    if (!link) throw new Error('Blob is not a verified descendant of the pinned root');
    return this.run(entry, signal, async (signal) => {
      const key = `${root}:${hash}`, hit = this.cache.get(key);
      if (hit) {
        this.counters.cacheHits++; this.cache.delete(key); this.cache.set(key, hit); return hit.slice();
      }
      const bytes = await this.client.fetchBlob(hash, entry.offer.hashtree!.fips!, signal);
      signal.throwIfAborted();
      if (!bytes) throw new Error('Signed FIPS providers do not have the requested blob');
      if (bytes.length > MAX_BLOB_BYTES) throw new Error('Atlas blob exceeds the 2 MiB preview bound');
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
        (b) => b.toString(16).padStart(2, '0')).join('');
      signal.throwIfAborted(); this.entry(root);
      if (digest !== hash) throw new Error('Atlas blob failed SHA-256 verification');
      this.authorizeChildren(proof, link, bytes);
      this.counters.verifiedBlobs++;
      const saved = bytes.slice(), previous = this.cache.get(key);
      this.cacheBytes -= previous?.length ?? 0; this.cache.delete(key); this.cache.set(key, saved); this.cacheBytes += saved.length;
      while (this.cacheBytes > MAX_CACHE_BYTES && this.cache.size) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.length; this.cache.delete(oldest);
      }
      return saved.slice();
    });
  }
  private authorizeChildren(proof: RootProof, parent: ProofLink, bytes: Uint8Array) {
    if (parent.type === LinkType.Blob) {
      if (bytes.length !== parent.size) throw new Error('Hashtree leaf length mismatch');
      return;
    }
    const node = decodeTreeNode(bytes);
    if (parent.depth >= 16 || node.type !== LinkType.File || !node.links.length || node.links.length > FANOUT)
      throw new Error('Unsupported Hashtree file node');
    let total = 0;
    const children = new Map<string, ProofLink>();
    for (const link of node.links) {
      if (!(link.hash instanceof Uint8Array) || link.hash.length !== 32 || link.key || link.name !== undefined ||
          ![LinkType.Blob, LinkType.File].includes(link.type) || !Number.isSafeInteger(link.size) || link.size <= 0)
        throw new Error('Invalid Hashtree file link');
      total += link.size;
      if (!Number.isSafeInteger(total) || total > parent.size) throw new Error('Hashtree subtree length mismatch');
      const hash = toHex(link.hash), old = proof.links.get(hash) ?? children.get(hash);
      if (old && (old.type !== link.type || old.size !== link.size)) throw new Error('Conflicting Hashtree file link');
      children.set(hash, { type: link.type, size: link.size, depth: parent.depth + 1 });
    }
    if (total !== parent.size) throw new Error('Hashtree subtree length mismatch');
    const additions = [...children.keys()].filter((hash) => !proof.links.has(hash)).length;
    if (this.proofLinks + additions > 1000000) throw new Error('Preview root membership limit reached');
    for (const [hash, link] of children) if (!proof.links.has(hash)) proof.links.set(hash, link);
    this.proofLinks += additions;
  }
  async request(root: string, raw: ConsumerRpcRequest, signal?: AbortSignal): Promise<FipsRpcResponse> {
    const entry = this.entry(root);
    if (!raw || typeof raw !== 'object' || Object.keys(raw).some((k) => !['path', 'method', 'body'].includes(k)))
      throw new Error('Invalid or unpinned map operation');
    const request = validateRpcRequest({ ...raw, root });
    const operation = request.path.replace(/^members\/m[0-9]{1,3}\//, '');
    if (request.method === 'GET' ? operation !== 'capabilities' || request.body !== undefined :
        !['route', 'isochrone', 'search', 'reverse', 'peak', 'features', 'offline'].includes(operation))
      throw new Error('Map operation is not allowed in this preview');
    if (new TextEncoder().encode(JSON.stringify(request)).length > 16 * 1024)
      throw new Error('Map operation request is too large');
    const providers = entry.offer.hashtree!.fips!.filter((provider) => provider.rpcPort === 39019);
    if (!providers.length) throw new Error('Map does not advertise FIPS server operations');
    const pinned = this.rpcPins.get(root) ?? providers[0]!.peerId;
    const provider = providers.find((provider) => provider.peerId === pinned);
    if (!provider) throw new Error('The pinned server operations provider was withdrawn; reload the preview to start a new server session');
    this.rpcPins.set(root, pinned);
    // Never replay an operation on a mirror after a lost or uncertain response.
    return this.run(entry, signal, (signal) => this.client.request(provider, request, signal));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(cancelled()); this.discovery?.abort(); clearTimeout(this.expiryTimer);
    this.cache.clear(); this.cacheBytes = 0; this.entries.clear(); this.proofs.clear(); this.rpcPins.clear(); this.proofLinks = 0;
    this.views.clear(); this.revisions.clear(); this.viewRevisions.clear(); this.withdrawals.clear(); this.deleted.clear();
    this.emit('catalog'); this.listeners.clear();
    return this.closing = this.client.stop();
  }
}
