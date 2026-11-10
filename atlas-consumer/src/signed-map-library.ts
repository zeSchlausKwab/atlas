import { verifyEvent, type Event } from 'nostr-tools/pure';
import { MAP_KIND, parseAnnouncement } from '../../packages/hashtree/src/announcement';
import { HASH, parseFipsProviders } from '../../packages/hashtree/src/offer';
import { VIEW_KIND, parseViewAnnouncement } from '../../packages/views/src/announcement';
import type { MapOffer } from '../../packages/format/src/catalog';
import {
  parseConsumerConfig,
  type ConsumerConfig,
  type ConsumerStatus,
} from './discovery-contract';
export type Entry = { offer: MapOffer; event: Event; abort: AbortController; expires: number };
const newer = (next: Event, old?: Event) =>
  !old ||
  next.created_at > old.created_at ||
  (next.created_at === old.created_at && next.id < old.id);
const cancelled = () => new DOMException('Map offer was superseded or withdrawn', 'AbortError');
/** Atlas semantics only: no relay pool, FIPS connection or shell authority. */
export class SignedMapLibrary {
  readonly config: ConsumerConfig;
  private lifetime = new AbortController();
  private entries = new Map<string, Entry>();
  private revisions = new Map<string, Event>();
  private withdrawals = new Map<string, number>();
  private deleted = new Set<string>();
  private views = new Map<
    string,
    ReturnType<typeof parseViewAnnouncement> & { expires?: number }
  >();
  private viewRevisions = new Map<string, Event>();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private error?: string;
  constructor(
    config: ConsumerConfig,
    private changed: () => void = () => {},
  ) {
    this.config = parseConsumerConfig(config);
  }
  private emit(_kind: 'catalog') {
    this.changed();
  }
  accept(event: unknown) {
    const kind = (event as Event)?.kind;
    return kind === 5
      ? this.acceptDeletion(event)
      : kind === VIEW_KIND
        ? this.acceptView(event)
        : this.acceptAnnouncement(event);
  }
  catalog(): Pick<ConsumerStatus, 'catalog' | 'defaultView' | 'preferredMapIds'> {
    this.expire();
    const catalog = [...this.entries.values()]
      .map(({ offer, event }) => ({
        key: `${event.pubkey}:${offer.id}@${offer.hashtree!.root}`,
        offer,
        publisher: event.pubkey,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const roots = new Set(catalog.map((entry) => entry.offer.hashtree!.root));
    const view = [...this.views.values()]
      .sort(
        (a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id),
      )
      .find((v) => v.recipe.sources.every((source) => roots.has(source.root)));
    return structuredClone({
      catalog,
      ...(view ? { defaultView: view.recipe } : {}),
      preferredMapIds: this.config.mapIds ?? [],
    });
  }
  acceptAnnouncement(raw: unknown): boolean {
    if (this.lifetime.signal.aborted) return false;
    let rejectedRevision: string | undefined;
    try {
      const { event, offer } = parseAnnouncement(raw);
      if (event.pubkey !== this.config.publisher || !offer.hashtree) return false;
      const address = `${event.pubkey}:${offer.id}`;
      if (
        !newer(event, this.revisions.get(address)) ||
        (this.withdrawals.get(address) ?? -1) >= event.created_at ||
        this.deleted.has(`${event.pubkey}:${event.id}`)
      )
        return false;
      if (!this.revisions.has(address) && this.revisions.size >= 4096) return false;
      this.revisions.set(address, event);
      rejectedRevision = address;
      const fips = parseFipsProviders(offer.hashtree.fips);
      if (!fips.length) throw new Error('Signed map does not advertise FIPS providers');
      for (const provider of fips) {
        if (
          provider.servicePort !== 39018 ||
          (provider.rpcPort !== undefined && provider.rpcPort !== 39019)
        )
          throw new Error('Unsupported signed FIPS service port');
        for (const seed of provider.seedUrls) {
          const url = new URL(seed);
          if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
            throw new Error('Unencrypted FIPS seeds must be loopback');
        }
      }
      const root = offer.hashtree.root;
      const previous = this.entries.get(address);
      previous?.abort.abort(cancelled());
      // Signed HTTP hints are intentionally absent from the consumer contract.
      const safe: MapOffer = {
        id: offer.id,
        url: `htree://${offer.hashtree.root}`,
        bytes: offer.bytes,
        manifest: offer.manifest,
        hashtree: { ...offer.hashtree, providers: [], fips },
      };
      this.entries.set(address, {
        offer: safe,
        event,
        abort: new AbortController(),
        expires: Number(event.tags.find((tag) => tag[0] === 'expiration')![1]),
      });

      this.error = undefined;
      rejectedRevision = undefined;
      this.scheduleExpiry();
      this.emit('catalog');
      return true;
    } catch {
      // A newer valid signed revision supersedes an older offer even if its transport is unsupported.
      if (rejectedRevision) {
        this.remove(rejectedRevision);
        this.scheduleExpiry();
        this.emit('catalog');
      }
      return false;
    }
  }
  acceptView(raw: unknown): boolean {
    if (this.lifetime.signal.aborted) return false;
    try {
      const parsed = parseViewAnnouncement(raw, this.config.publisher),
        key = `view:${parsed.event.pubkey}:${parsed.recipe.id}`;
      if (
        !newer(parsed.event, this.viewRevisions.get(key)) ||
        (this.withdrawals.get(key) ?? -1) >= parsed.event.created_at ||
        this.deleted.has(`${parsed.event.pubkey}:${parsed.event.id}`) ||
        (this.viewRevisions.size >= 128 && !this.viewRevisions.has(key))
      )
        return false;
      const expiration = parsed.event.tags.filter((tag) => tag[0] === 'expiration');
      const expires = expiration.length ? Number(expiration[0]![1]) : undefined;
      this.viewRevisions.set(key, parsed.event);
      if (
        expiration.length > 1 ||
        (expires !== undefined && (!Number.isSafeInteger(expires) || expires <= Date.now() / 1000))
      ) {
        this.views.delete(key);
        this.scheduleExpiry();
        this.emit('catalog');
        return false;
      }
      this.views.set(key, { ...parsed, expires });
      this.scheduleExpiry();
      this.emit('catalog');
      return true;
    } catch {
      return false;
    }
  }
  acceptDeletion(raw: unknown): boolean {
    if (this.lifetime.signal.aborted) return false;
    try {
      if (JSON.stringify(raw).length > 256 * 1024) return false;
      const event = JSON.parse(JSON.stringify(raw)) as Event;
      if (
        event.kind !== 5 ||
        event.pubkey !== this.config.publisher ||
        !verifyEvent(event) ||
        event.created_at > Math.floor(Date.now() / 1000) + 300
      )
        return false;
      for (const tag of event.tags) {
        const prefix = `${MAP_KIND}:${event.pubkey}:atlas/`;
        if (tag[0] === 'a' && tag[1]?.startsWith(prefix)) {
          const address = `${event.pubkey}:${tag[1].slice(prefix.length)}`;
          this.withdrawals.set(
            address,
            Math.max(event.created_at, this.withdrawals.get(address) ?? -1),
          );
          const entry = this.entries.get(address);
          if (entry && entry.event.created_at <= event.created_at) this.remove(address);
        } else if (
          tag[0] === 'a' &&
          tag[1]?.startsWith(`${VIEW_KIND}:${event.pubkey}:atlas-view/`)
        ) {
          const address = `view:${event.pubkey}:${tag[1].slice(`${VIEW_KIND}:${event.pubkey}:atlas-view/`.length)}`;
          this.withdrawals.set(
            address,
            Math.max(event.created_at, this.withdrawals.get(address) ?? -1),
          );
          const view = this.views.get(address);
          if (view && view.event.created_at <= event.created_at) this.views.delete(address);
        } else if (tag[0] === 'e' && HASH.test(tag[1] ?? '')) {
          this.deleted.add(`${event.pubkey}:${tag[1]}`);
          for (const [address, entry] of this.entries)
            if (entry.event.id === tag[1] && entry.event.created_at <= event.created_at)
              this.remove(address);
          for (const [address, view] of this.views)
            if (view.event.id === tag[1] && view.event.created_at <= event.created_at)
              this.views.delete(address);
        }
      }
      this.scheduleExpiry();
      this.emit('catalog');
      return true;
    } catch {
      return false;
    }
  }
  private remove(address: string) {
    const old = this.entries.get(address);
    if (!old) return;
    old.abort.abort(cancelled());
    this.entries.delete(address);
  }
  private expire() {
    let changed = false;
    for (const [address, entry] of this.entries)
      if (entry.expires <= Date.now() / 1000) {
        this.remove(address);
        changed = true;
      }
    for (const [address, view] of this.views)
      if (view.expires !== undefined && view.expires <= Date.now() / 1000) {
        this.views.delete(address);
        changed = true;
      }
    if (changed) {
      this.scheduleExpiry();
      this.emit('catalog');
    }
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const deadlines = [...this.entries.values()]
      .map((entry) => entry.expires)
      .concat(
        [...this.views.values()].flatMap((view) =>
          view.expires === undefined ? [] : [view.expires],
        ),
      );
    if (!deadlines.length) return;
    const next = Math.min(...deadlines);
    this.expiryTimer = setTimeout(
      () => {
        this.expire();
        this.scheduleExpiry();
      },
      Math.min(2147483647, Math.max(1, next * 1000 - Date.now())),
    );
  }
  entry(root: string): Entry {
    this.lifetime.signal.throwIfAborted();
    this.expire();
    if (typeof root !== 'string' || !HASH.test(root)) throw new Error('Invalid pinned map root');
    const entry = [...this.entries.values()].find((e) => e.offer.hashtree!.root === root);
    if (!entry) throw new Error('Map root is not in the active signed catalog');
    return entry;
  }

  close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(cancelled());
    clearTimeout(this.expiryTimer);
    for (const entry of this.entries.values()) entry.abort.abort(cancelled());
    this.entries.clear();
    this.views.clear();
    this.revisions.clear();
    this.viewRevisions.clear();
    this.withdrawals.clear();
    this.deleted.clear();
  }
}
