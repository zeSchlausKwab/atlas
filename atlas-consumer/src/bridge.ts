import { outbox, config, type OutboxSubscription } from '@napplet/sdk';
import {
  fipsResources,
  type FipsBinding,
  type FipsRoot,
  type FipsStats,
} from './vendor/fips-resource-client';
import { SignedMapLibrary, type Entry } from './signed-map-library';
import { MAP_KIND } from '../../packages/hashtree/src/announcement';
import { VIEW_KIND } from '../../packages/views/src/announcement';
import {
  consumerError,
  type ConsumerConfig,
  type ConsumerStatus,
  type ConsumerRpcRequest,
  type PreviewStats,
} from './discovery-contract';
export type { ConsumerStatus, PreviewStats };
export type PreviewUpdate = ConsumerStatus | { stats: PreviewStats };
const defaults: ConsumerConfig = {
  publisher: 'eb0d114743da12e854bbe723393b97c5e8beddc38ebb47a3a6fd4bd63274a191',
  relayUrls: ['wss://relay.primal.net/', 'wss://relay.snort.social/'],
  mapIds: [],
};
const emptyStats: FipsStats = {
  networkRequests: 0,
  fipsBytes: 0,
  activeTransfers: 0,
  queuedTransfers: 0,
  retries: 0,
  failovers: 0,
  verifiedBlobs: 0,
  cacheHits: 0,
  errors: 0,
  cancelledRequests: 0,
};
type Grant = { entry: Entry; promise: Promise<string>; abort: AbortController };
/** Uses standard OUTBOX and an explicitly experimental, shell-owned resource SDK. */
export class PreviewBridge {
  private library?: SignedMapLibrary;
  private api?: FipsBinding;
  private live?: OutboxSubscription;
  private unstats?: () => void;
  private lifetime = new AbortController();
  private grants = new Map<string, Grant>();
  private batch: Array<{
    root: string;
    grant: Grant;
    resolve: (id: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  private approving = false;
  private stats: PreviewStats = { ...emptyStats, requests: 0, pending: 0 };
  private ready = false;
  private settled = false;
  private generation = 0;
  private messages: string[] = [];
  private error?: string;
  private timeoutMs = 20 * 60_000;
  constructor(
    private changed: (status: PreviewUpdate) => void,
    private dependencies: {
      resources?: FipsBinding;
      outbox?: Pick<typeof outbox, 'query' | 'subscribe'>;
      configuration?: ConsumerConfig;
    } = {},
  ) {}
  private snapshot(): ConsumerStatus {
    const catalog = this.library?.catalog() ?? { catalog: [], preferredMapIds: [] };
    // A relay timeout does not invalidate the offers already verified by the library.
    const error = catalog.catalog.length ? undefined : this.error;
    return {
      version: 2,
      state: this.lifetime.signal.aborted
        ? 'closed'
        : error
          ? 'error'
          : this.settled
            ? 'ready'
            : 'discovering',
      ...catalog,
      discovery: {
        publishers: [this.library?.config.publisher ?? defaults.publisher],
        relayUrls: this.library?.config.relayUrls ?? defaults.relayUrls,
        messages: this.messages,
        ready: this.ready,
        settled: this.settled,
      },
      stats: this.stats,
      requestTimeoutMs: this.timeoutMs,
      ...(error ? { error } : {}),
    };
  }
  private update = () => {
    if (this.lifetime.signal.aborted) return;
    for (const [root, grant] of this.grants) {
      let active = false;
      try {
        active = this.library?.entry(root) === grant.entry;
      } catch {}
      if (!active) this.release(root, grant);
    }
    this.changed(this.snapshot());
  };
  private release(root: string, grant: Grant) {
    if (this.grants.get(root) === grant) this.grants.delete(root);
    grant.abort.abort(new DOMException('Signed map grant retired', 'AbortError'));
    void grant.promise.then((id) => this.api?.release(id)).catch(() => {});
  }
  async status(): Promise<ConsumerStatus> {
    this.lifetime.signal.throwIfAborted();
    if (this.library) return this.snapshot();
    this.api = this.dependencies.resources ?? fipsResources();
    const info = await this.api.info();
    this.lifetime.signal.throwIfAborted();
    if (!info.enabled)
      throw new Error('Enable experimental FIPS resources in shell Network settings.');
    this.timeoutMs = info.timeoutMs;
    this.unstats = this.api.subscribe((stats) => {
      this.stats = { ...this.stats, ...stats };
      if (!this.lifetime.signal.aborted) this.changed({ stats: this.stats });
    });
    let settings: Record<string, unknown> = {};
    if (!this.dependencies.configuration) {
      try {
        settings = await config.get();
      } catch {
        /* Optional CONFIG: use documented public defaults. */
      }
    }
    this.lifetime.signal.throwIfAborted();
    const configuration = this.dependencies.configuration ?? {
      ...defaults,
      ...(typeof settings.publisher === 'string' && settings.publisher.trim()
        ? { publisher: settings.publisher.trim() }
        : {}),
      ...(typeof settings.discoveryRelays === 'string' && settings.discoveryRelays.trim()
        ? { relayUrls: settings.discoveryRelays.trim().split(/\s+/) }
        : {}),
      ...(typeof settings.preferredMaps === 'string'
        ? { mapIds: settings.preferredMaps.trim().split(/\s+/).filter(Boolean) }
        : {}),
    };
    this.library = new SignedMapLibrary(configuration, this.update);
    return this.refresh();
  }
  async refresh(): Promise<ConsumerStatus> {
    this.lifetime.signal.throwIfAborted();
    if (!this.library) return this.status();
    this.live?.close();
    const generation = ++this.generation,
      live = () => !this.lifetime.signal.aborted && generation === this.generation;
    this.ready = false;
    this.settled = false;
    this.error = undefined;
    this.messages = ['Looking up signed offers through the shell OUTBOX'];
    this.update();
    const { publisher, relayUrls } = this.library.config;
    const filters = [
      {
        authors: [publisher],
        kinds: [MAP_KIND, VIEW_KIND],
        '#t': ['atlas-map', 'atlas-view'],
        limit: 100,
      },
      { authors: [publisher], kinds: [5], limit: 100 },
    ];
    const options = { authors: [publisher], relays: relayUrls, limit: 200, timeoutMs: 10000 };
    const api = this.dependencies.outbox ?? outbox;
    try {
      this.live = api.subscribe(filters, options);
      this.live.on('event', (result) => {
        if (live()) this.library!.accept(result.event);
      });
      this.live.on('closed', (reason) => {
        if (live()) {
          this.ready = false;
          this.messages = [
            reason ??
              'Discovery closed; refresh to reconnect. Existing snapshots remain pinned until expiry.',
          ];
          this.update();
        }
      });
      const result = await api.query(filters, options);
      if (live()) {
        for (const record of result.events) this.library.accept(record.event);
        this.settled = true;
        this.ready = !result.error && !result.incomplete;
        this.error = result.error ?? (result.incomplete ? 'No complete discovery result was received; refresh to retry.' : undefined);
        this.messages = this.ready
          ? ['Listening for signed map offers and withdrawals.']
          : [
              ...(result.error ? [result.error] : []),
              'Discovery may be incomplete; refresh to retry. Verified maps remain available.',
            ];
        this.update();
      }
    } catch (error) {
      if (live()) {
        this.settled = true;
        this.error = consumerError(error);
        this.messages = [
          this.error,
          'Discovery may be incomplete; refresh to retry. Verified maps remain available.',
        ];
        this.update();
      }
    }
    return this.snapshot();
  }
  private grant(root: string): Grant {
    this.lifetime.signal.throwIfAborted();
    const entry = this.library!.entry(root);
    const old = this.grants.get(root);
    if (old?.entry === entry) return old;
    if (old) this.release(root, old);
    let resolve!: (id: string) => void, reject!: (error: unknown) => void;
    const promise = new Promise<string>((a, b) => {
      resolve = a;
      reject = b;
    });
    const grant = { entry, promise, abort: new AbortController() };
    this.grants.set(root, grant);
    this.batch.push({ root, grant, resolve, reject });
    queueMicrotask(() => {
      void this.openBatch();
    });
    return grant;
  }
  private async openBatch() {
    if (this.approving || !this.batch.length) return;
    this.approving = true;
    const batch = this.batch.splice(0);
    const roots: FipsRoot[] = batch.map(({ grant }) => {
      const tree = grant.entry.offer.hashtree!;
      return {
        root: tree.root,
        bytes: tree.bytes,
        chunkBytes: tree.chunkBytes,
        providers: tree.fips!,
        expires: grant.entry.expires,
      };
    });
    try {
      const ids = await this.api!.open(roots, { signal: this.lifetime.signal });
      for (const [i, item] of batch.entries()) {
        if (item.grant.abort.signal.aborted) {
          void this.api!.release(ids[i]).catch(() => {});
          item.reject(item.grant.abort.signal.reason);
        } else item.resolve(ids[i]);
      }
    } catch (error) {
      for (const item of batch) {
        if (this.grants.get(item.root) === item.grant) this.grants.delete(item.root);
        item.reject(error);
      }
    } finally {
      this.approving = false;
      if (this.batch.length) void this.openBatch();
    }
  }
  private async use<T>(
    root: string,
    signal: AbortSignal | undefined,
    action: (id: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const grant = this.grant(root);
    const combined = AbortSignal.any([
      this.lifetime.signal,
      grant.abort.signal,
      grant.entry.abort.signal,
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    this.stats.requests++;
    this.stats.pending++;
    try {
      const id = await abortable(grant.promise, combined);
      combined.throwIfAborted();
      const value = await action(id, combined);
      combined.throwIfAborted();
      this.library!.entry(root);
      return value;
    } finally {
      this.stats.pending--;
    }
  }
  blob(hash: string, root: string, signal?: AbortSignal) {
    return this.use(root, signal, (id, s) => this.api!.bytes(id, hash, { signal: s }));
  }
  request(root: string, operation: ConsumerRpcRequest, signal?: AbortSignal) {
    return this.use(root, signal, (id, s) => this.api!.request(id, operation, { signal: s }));
  }
  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new DOMException('Napplet closed', 'AbortError'));
    ++this.generation;
    this.live?.close();
    this.unstats?.();
    this.library?.close();
    for (const [root, grant] of this.grants) this.release(root, grant);
    for (const item of this.batch.splice(0)) item.reject(this.lifetime.signal.reason);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
