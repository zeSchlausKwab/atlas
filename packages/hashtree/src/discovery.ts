import { VIEW_KIND, parseViewAnnouncement } from "../../views/src/announcement";
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { parseCatalog, type MapOffer } from "../../format/src/catalog";
import { HASH } from "./source";
export const MAP_KIND = 30064;
export function relayUrl(value: string) {
  const u = new URL(value);
  if (
    !["ws:", "wss:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new Error("Invalid relay URL");
  return u.href;
}
export function mapAnnouncement(
  offer: MapOffer,
  secret: Uint8Array,
  time = Math.floor(Date.now() / 1000),
): Event {
  if (!offer.hashtree) throw new Error("Index this map with Hashtree first");
  const event = finalizeEvent(
    {
      kind: MAP_KIND,
      created_at: time,
      tags: [
        ["d", `atlas/${offer.id}`],
        ["l", "hashtree"],
        ["t", "atlas-map"],
        ["hash", offer.hashtree.root],
        ["expiration", String(time + 7 * 86400)],
      ],
      content: JSON.stringify({
        version: 1,
        map: { ...offer, manifest: { ...offer.manifest, places: [] } },
      }),
    },
    secret,
  );
  parseAnnouncement(event, time);
  return event;
}
export function parseAnnouncement(
  event: unknown,
  now = Math.floor(Date.now() / 1000),
): { event: Event; offer: MapOffer } {
  if (JSON.stringify(event).length > 256 * 1024)
    throw new Error("Oversized map announcement");
  // Caller-owned nostr-tools objects may carry a cached verification symbol.
  const e = JSON.parse(JSON.stringify(event)) as Event;
  if (
    !e ||
    e.kind !== MAP_KIND ||
    !verifyEvent(e) ||
    e.created_at > now + 300 ||
    !e.tags.some((t) => t[0] === "l" && t[1] === "hashtree") ||
    !e.tags.some((t) => t[0] === "t" && t[1] === "atlas-map")
  )
    throw new Error("Invalid signed map announcement");
  const tag = (key: string) => {
    const ts = e.tags.filter((t) => t[0] === key);
    if (ts.length !== 1) throw new Error(`Invalid ${key} tag`);
    return ts[0]![1]!;
  };
  const expiration = Number(tag("expiration"));
  if (
    !Number.isSafeInteger(expiration) ||
    expiration <= now ||
    expiration > e.created_at + 7 * 86400
  )
    throw new Error("Expired map announcement");
  if (
    e.tags.some((t) =>
      ["key", "encryptedKey", "selfEncryptedKey"].includes(t[0]!),
    )
  )
    throw new Error("Encrypted map offers are not supported yet");
  const content = JSON.parse(e.content);
  if (content.version !== 1) throw new Error("Unsupported map announcement");
  const offer = parseCatalog({ maps: [content.map] }, content.map.url)[0]!;
  if (
    !offer.hashtree ||
    offer.hashtree.root !== tag("hash") ||
    tag("d") !== `atlas/${offer.id}`
  )
    throw new Error("Map root or identity mismatch");
  return { event: e, offer };
}
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
    withdrawn?: (id: string, publisher: string, event: Event) => void;
  } = {},
) {
  if (
    !authors.length ||
    authors.length > 16 ||
    !authors.every((a) => HASH.test(a))
  )
    throw new Error("Choose 1–16 publisher public keys");
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
      "Discovery relay disconnected; existing map snapshots remain pinned. Reconnect to discover updates.",
    );
  const sub = relay.subscribe(
    [
      {
        kinds: acceptView ? [MAP_KIND, VIEW_KIND] : [MAP_KIND],
        authors,
        "#t": acceptView ? ["atlas-map", "atlas-view"] : ["atlas-map"],
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
            if (
              !verifyEvent(deletion) ||
              deletion.created_at > Math.floor(Date.now() / 1000) + 300
            )
              return;
            const keys = new Map<string, boolean>();
            for (const tag of deletion.tags) {
              if (
                tag[0] === "a" &&
                tag[1]?.startsWith(`${MAP_KIND}:${deletion.pubkey}:atlas/`)
              )
                keys.set(
                  `${deletion.pubkey}:${tag[1].slice(`${MAP_KIND}:${deletion.pubkey}:`.length)}`,
                  true,
                );
              if (tag[0] === "e" && HASH.test(tag[1] ?? "")) {
                deletedEvents.add(`${deletion.pubkey}:${tag[1]}`);
                for (const [key, old] of seen)
                  if (
                    old.kind === MAP_KIND &&
                    old.pubkey === deletion.pubkey &&
                    old.id === tag[1]
                  )
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
            key = `${event.pubkey}:${event.tags.find((t) => t[0] === "d")![1]}`;
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
        report(
          "Listening for signed map offers. Choose discovered maps below.",
        );
      },
    },
  );
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    relay.onclose = null;
    // This subscription owns the socket, so a wire CLOSE is unnecessary.
    // nostr-tools defers send() through a promise; sub.close() followed by
    // relay.close() otherwise writes that frame after the socket has closed.
    sub.oneose = undefined;
    sub.receivedEose();
    sub.closed = true;
    relay.close();
  };
  signal.addEventListener("abort", close, { once: true });
  return close;
}
export async function publishAnnouncement(
  url: string,
  event: Event,
  timeoutMs = 10_000,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid relay publication timeout");
  signal?.throwIfAborted();
  const relay = new Relay(relayUrl(url), { enableReconnect: false });
  const started = performance.now();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      relay.close();
      reject(
        signal?.reason ?? new DOMException("Publication aborted", "AbortError"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      aborted,
      (async () => {
        await relay.connect({ timeout: timeoutMs });
        signal?.throwIfAborted();
        relay.publishTimeout = Math.max(
          1,
          timeoutMs - (performance.now() - started),
        );
        await relay.publish(event);
      })(),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    relay.close();
  }
}
