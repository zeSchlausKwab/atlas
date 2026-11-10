import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import { parseCatalog, type MapOffer } from '../../format/src/catalog';
export const MAP_KIND = 30064;
export function relayUrl(value: string) {
  const u = new URL(value);
  if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash)
    throw new Error('Invalid relay URL');
  return u.href;
}
export function mapAnnouncement(
  offer: MapOffer,
  secret: Uint8Array,
  time = Math.floor(Date.now() / 1000),
): Event {
  if (!offer.hashtree) throw new Error('Index this map with Hashtree first');
  const event = finalizeEvent(
    {
      kind: MAP_KIND,
      created_at: time,
      tags: [
        ['d', `atlas/${offer.id}`],
        ['l', 'hashtree'],
        ['t', 'atlas-map'],
        ['hash', offer.hashtree.root],
        ['expiration', String(time + 7 * 86400)],
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
  if (JSON.stringify(event).length > 256 * 1024) throw new Error('Oversized map announcement');
  // Caller-owned nostr-tools objects may carry a cached verification symbol.
  const e = JSON.parse(JSON.stringify(event)) as Event;
  if (
    !e ||
    e.kind !== MAP_KIND ||
    !verifyEvent(e) ||
    e.created_at > now + 300 ||
    !e.tags.some((t) => t[0] === 'l' && t[1] === 'hashtree') ||
    !e.tags.some((t) => t[0] === 't' && t[1] === 'atlas-map')
  )
    throw new Error('Invalid signed map announcement');
  const tag = (key: string) => {
    const ts = e.tags.filter((t) => t[0] === key);
    if (ts.length !== 1) throw new Error(`Invalid ${key} tag`);
    return ts[0]![1]!;
  };
  const expiration = Number(tag('expiration'));
  if (
    !Number.isSafeInteger(expiration) ||
    expiration <= now ||
    expiration > e.created_at + 7 * 86400
  )
    throw new Error('Expired map announcement');
  if (e.tags.some((t) => ['key', 'encryptedKey', 'selfEncryptedKey'].includes(t[0]!)))
    throw new Error('Encrypted map offers are not supported yet');
  const content = JSON.parse(e.content);
  if (content.version !== 1) throw new Error('Unsupported map announcement');
  const offer = parseCatalog({ maps: [content.map] }, content.map.url)[0]!;
  if (!offer.hashtree || offer.hashtree.root !== tag('hash') || tag('d') !== `atlas/${offer.id}`)
    throw new Error('Map root or identity mismatch');
  return { event: e, offer };
}
