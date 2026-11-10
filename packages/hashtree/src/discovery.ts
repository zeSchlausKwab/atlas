import { VIEW_KIND, parseViewAnnouncement } from '../../views/src/announcement';
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { parseCatalog, type MapOffer } from '../../format/src/catalog';
import { HASH } from './source';
export { MAP_KIND, relayUrl, mapAnnouncement, parseAnnouncement } from './announcement';
import { MAP_KIND, relayUrl, parseAnnouncement } from './announcement';
/** Keep subscriptions open after EOSE; silence is never evidence of global absence. */
export async function watchMaps(
  url: string,
  authors: string[],
  accept: (offer: MapOffer, event: Event) => void,
  signal: AbortSignal,
  report: (message: string) => void = () => {},
  acceptView?: (view: ReturnType<typeof parseViewAnnouncement>) => void,
  options: {
    ready?: () => void;
    /** Observe validated deletions, including unknown event IDs, across relay subscriptions. */
    deleted?: (event: Event) => void;
    withdrawn?: (id: string, publisher: string, event: Event) => void;
  } = {},
) {
  if (!authors.length || authors.length > 16 || !authors.every((a) => HASH.test(a)))
    throw new Error('Choose 1–16 publisher public keys');
  const relay = await Relay.connect(relayUrl(url), {
    timeout: 10_000,
    abort: signal,
  });
  if (signal.aborted) {
    relay.close();
    signal.throwIfAborted();
  }
  let closed = false;
  const seen = new Map<string, Event>();
  const withdrawn = new Map<string, number>();
  const deletedEvents = new Set<string>();
  relay.onclose = () =>
    report(
      'Discovery relay disconnected; existing map snapshots remain pinned. Reconnect to discover updates.',
    );
  const sub = relay.subscribe(
    [
      {
        kinds: acceptView ? [MAP_KIND, VIEW_KIND] : [MAP_KIND],
        authors,
        '#t': acceptView ? ['atlas-map', 'atlas-view'] : ['atlas-map'],
        limit: 100,
      },
      { kinds: [5], authors, limit: 100 },
    ],
    {
      onevent(event) {
        if (closed) return;
        try {
          if (!authors.includes(event.pubkey)) return;
          if (event.kind === 5) {
            if (JSON.stringify(event).length > 256 * 1024) return;
            const deletion = JSON.parse(JSON.stringify(event)) as Event;
            if (!verifyEvent(deletion) || deletion.created_at > Math.floor(Date.now() / 1000) + 300)
              return;
            options.deleted?.(deletion);
            const keys = new Map<string, boolean>();
            for (const tag of deletion.tags) {
              if (tag[0] === 'a' && tag[1]?.startsWith(`${MAP_KIND}:${deletion.pubkey}:atlas/`))
                keys.set(
                  `${deletion.pubkey}:${tag[1].slice(`${MAP_KIND}:${deletion.pubkey}:`.length)}`,
                  true,
                );
              if (tag[0] === 'e' && HASH.test(tag[1] ?? '')) {
                deletedEvents.add(`${deletion.pubkey}:${tag[1]}`);
                for (const [key, old] of seen)
                  if (old.kind === MAP_KIND && old.pubkey === deletion.pubkey && old.id === tag[1])
                    if (!keys.has(key)) keys.set(key, false);
              }
            }
            for (const [key, addressDeletion] of keys) {
              const old = seen.get(key);
              if (
                (old && old.created_at > deletion.created_at) ||
                (withdrawn.get(key) ?? -1) >= deletion.created_at
              )
                continue;
              if (addressDeletion) withdrawn.set(key, deletion.created_at);
              seen.delete(key);
              options.withdrawn?.(
                key.slice(`${deletion.pubkey}:atlas/`.length),
                deletion.pubkey,
                deletion,
              );
            }
            return;
          }
          if (event.kind === VIEW_KIND && acceptView) {
            const parsed = parseViewAnnouncement(event);
            const key = `${event.pubkey}:view:${parsed.recipe.id}`;
            const old = seen.get(key);
            if (
              old &&
              (old.created_at > event.created_at ||
                (old.created_at === event.created_at && old.id <= event.id))
            )
              return;
            seen.set(key, event);
            acceptView(parsed);
            return;
          }
          const parsed = parseAnnouncement(event),
            key = `${event.pubkey}:${event.tags.find((t) => t[0] === 'd')![1]}`;
          if (
            (withdrawn.get(key) ?? -1) >= event.created_at ||
            deletedEvents.has(`${event.pubkey}:${event.id}`)
          )
            return;
          const old = seen.get(key);
          if (
            old &&
            (old.created_at > event.created_at ||
              (old.created_at === event.created_at && old.id <= event.id))
          )
            return;
          seen.set(key, event);
          accept(parsed.offer, event);
        } catch {
          /* Invalid, stale or unsupported offers do not enter the catalog. */
        }
      },
      oneose() {
        if (closed) return;
        options.ready?.();
        report('Listening for signed map offers. Choose discovered maps below.');
      },
    },
  );
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    relay.onclose = null;
    // This subscription owns the socket, so a wire CLOSE is unnecessary.
    // nostr-tools defers send() through a promise; sub.close() followed by
    // relay.close() otherwise writes that frame after the socket has closed.
    sub.oneose = undefined;
    sub.receivedEose();
    sub.closed = true;
    relay.close();
  };
  signal.addEventListener('abort', close, { once: true });
  return close;
}
export async function publishAnnouncement(
  url: string,
  event: Event,
  timeoutMs = 10_000,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid relay publication timeout');
  signal?.throwIfAborted();
  const relay = new Relay(relayUrl(url), { enableReconnect: false });
  const started = performance.now();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      relay.close();
      reject(signal?.reason ?? new DOMException('Publication aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([
      aborted,
      (async () => {
        await relay.connect({ timeout: timeoutMs });
        signal?.throwIfAborted();
        relay.publishTimeout = Math.max(1, timeoutMs - (performance.now() - started));
        await relay.publish(event);
      })(),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    relay.close();
  }
}
