import { afterEach, expect, spyOn, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { encodeAndHash, fromHex, LinkType, toHex } from '@hashtree/core';
import { mapAnnouncement, publishAnnouncement, watchMaps } from '../../packages/hashtree/src/discovery';
import { viewAnnouncement } from '../../packages/views/src/announcement';
import { defaultPresentation } from '../../packages/views/src/index';
import type { MapOffer } from '../../packages/format/src/catalog';
import type { FipsClient } from '../../packages/fips/src/client';
import { localRelay } from '../../tests/helpers/nostr-relay';
import { parseConsumerConfig } from './consumer-protocol';
import { ConsumerSession } from './consumer-session';

const key = generateSecretKey(), publisher = getPublicKey(key);
const config = { publisher, relayUrls: ['ws://127.0.0.1:9/'], mapIds: ['a'], timeoutMs: 1000 };
const provider = { peerId: '02' + 'b'.repeat(64), seedUrls: ['wss://seed.example/fips'], servicePort: 39018, rpcPort: 39019 };
const now = () => Math.floor(Date.now() / 1000);
const hashOf = async (bytes: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
const sessions: ConsumerSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); });
function offer(root: string, bytes: number, id = 'a', chunkBytes = 65536): MapOffer {
  return { id, url: `htree://${root}`, bytes, hashtree: { version: 1, root, bytes, chunkBytes, providers: [], fips: [provider] },
    manifest: { format: 'atlas', version: 1, name: id, snapshot: 'd'.repeat(64), bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 2,
      features: 0, peaks: 0, places: [], capabilities: [], limitations: [], source: { url: 'https://source.example', sha256: 'd'.repeat(64), attribution: 'Test' } } };
}
function harness(watch: typeof watchMaps = async () => () => {}) {
  const blobs = new Map<string, Uint8Array>();
  const calls: Array<{ hash: string; providers: Parameters<FipsClient['fetchBlob']>[1]; signal?: AbortSignal }> = [];
  const rpc: Array<{ provider: Parameters<FipsClient['request']>[0]; request: Parameters<FipsClient['request']>[1] }> = [];
  let received = 0, stopped = 0;
  const client: Pick<FipsClient, 'fetchBlob' | 'request' | 'status' | 'stop'> = {
    fetchBlob: async (hash, providers, signal) => { calls.push({ hash, providers, signal }); const bytes = blobs.get(hash) ?? null; received += bytes?.length ?? 0; return bytes; },
    request: async (provider, request) => { rpc.push({ provider, request }); return { status: 200, body: { ok: true } }; },
    status: () => ({ requests: calls.length, bytesReceived: received, retries: 0, failovers: 0, rpcRequests: rpc.length, activeTransfers: 0, queuedTransfers: 0, connections: 0 }),
    stop: async () => { stopped++; },
  };
  const session = new ConsumerSession(config, { client, watch }); sessions.push(session);
  return { session, client, calls, rpc, blobs, stopped: () => stopped };
}
async function leaf(h: ReturnType<typeof harness>, id = 'a', byte = 1) {
  const bytes = new Uint8Array([byte, 2, 3]), root = await hashOf(bytes);
  h.blobs.set(root, bytes); const map = offer(root, bytes.length, id), event = mapAnnouncement(map, key);
  expect(h.session.acceptAnnouncement(event)).toBe(true); return { root, bytes, map, event };
}
function deletion(tags: string[][], time = now(), secret = key) {
  return finalizeEvent({ kind: 5, content: '', tags, created_at: time }, secret);
}

test('config validates trust keys, bounded relay URLs and loopback plaintext', () => {
  expect(parseConsumerConfig(config)).toMatchObject(config);
  for (const bad of [{ ...config, publisher: 'b'.repeat(66) }, { ...config, relayUrls: ['https://relay.example'] },
    { ...config, relayUrls: ['ws://relay.example'] }, { ...config, relayUrls: ['wss://user:pass@relay.example'] },
    { ...config, timeoutMs: 10 }, { ...config, mapIds: [5] }]) expect(() => parseConsumerConfig(bad)).toThrow();
});

test('signed catalog accepts only the configured publisher and strips HTTP delivery hints', async () => {
  const h = harness(), a = await leaf(h);
  const bad = mapAnnouncement(a.map, generateSecretKey());
  expect(h.session.acceptAnnouncement(bad)).toBe(false);
  const tampered = { ...a.event, content: a.event.content.replace('"name":"a"', '"name":"evil"') };
  expect(h.session.acceptAnnouncement(tampered)).toBe(false);
  const legacyHints = { ...a.map, id: 'legacy', url: 'https://unused.example/map.atlas', api: 'https://unused.example/api',
    hashtree: { ...a.map.hashtree!, providers: ['https://unused.example/blobs'] } };
  expect(h.session.acceptAnnouncement(mapAnnouncement(legacyHints, key))).toBe(true);
  const entry = h.session.status().catalog.find((entry) => entry.offer.id === 'legacy')!;
  expect(entry.key).toBe(`${publisher}:legacy@${a.root}`);
  expect(entry.offer.url).toBe(`htree://${a.root}`); expect(entry.offer.api).toBeUndefined();
  expect(entry.offer.hashtree!.providers).toEqual([]);
  entry.offer.hashtree!.fips![0]!.peerId = '03' + 'c'.repeat(64);
  await h.session.blob(a.root, a.root);
  expect(h.calls[0]!.providers[0]!.peerId).toBe(provider.peerId);
});

test('malformed or unsupported signed FIPS providers never enter the catalog', () => {
  const h = harness(), base = offer('a'.repeat(64), 3);
  for (const fips of [[], [{ ...provider, servicePort: 4444 }], [{ ...provider, rpcPort: 4444 }],
    [{ ...provider, seedUrls: ['ws://public.example/fips'] }]]) {
    const map = { ...base, hashtree: { ...base.hashtree!, providers: ['https://unused.example'], fips } };
    expect(h.session.acceptAnnouncement(mapAnnouncement(map, key))).toBe(false);
  }
  expect(h.session.status().catalog).toHaveLength(0);
});

test('multimap reads select their signed provider and reject unaccepted roots or unrelated hashes', async () => {
  const h = harness(), a = await leaf(h, 'a', 1), b = await leaf(h, 'b', 9);
  const bProvider = { ...provider, peerId: '03' + 'c'.repeat(64) };
  const bMap = { ...b.map, hashtree: { ...b.map.hashtree!, fips: [bProvider] } };
  h.session.acceptAnnouncement(mapAnnouncement(bMap, key, now() + 1));
  expect(await h.session.blob(a.root, a.root)).toEqual(a.bytes);
  expect(await h.session.blob(b.root, b.root)).toEqual(b.bytes);
  expect(h.calls.map((call) => call.providers[0]!.peerId)).toEqual([provider.peerId, bProvider.peerId]);
  await expect(h.session.blob(a.root, 'f'.repeat(64))).rejects.toThrow('active signed');
  await expect(h.session.blob(b.root, a.root)).rejects.toThrow('descendant');
  expect(h.calls).toHaveLength(2);
});

test('Merkle descendants become authorized only after verified parent nodes', async () => {
  const h = harness();
  const a = new Uint8Array(16384).fill(1), b = new Uint8Array(16384).fill(2);
  const ah = await hashOf(a), bh = await hashOf(b);
  const node = await encodeAndHash({ type: LinkType.File, links: [a, b].map((bytes, i) => ({
    hash: fromHex(i ? bh : ah), size: bytes.length, type: LinkType.Blob })) });
  const root = toHex(node.hash); h.blobs.set(root, node.data); h.blobs.set(ah, a); h.blobs.set(bh, b);
  h.session.acceptAnnouncement(mapAnnouncement(offer(root, a.length + b.length, 'tree', 16384), key));
  await expect(h.session.blob(ah, root)).rejects.toThrow('descendant');
  await h.session.blob(root, root); expect(await h.session.blob(ah, root)).toEqual(a);
  expect(await h.session.blob(bh, root)).toEqual(b);
  expect(h.calls).toHaveLength(3);
});

test('corrupt bytes cannot authorize descendants or enter the verified cache', async () => {
  const h = harness(), a = await leaf(h); h.blobs.set(a.root, new Uint8Array([8, 9, 10]));
  await expect(h.session.blob(a.root, a.root)).rejects.toThrow('SHA-256');
  await expect(h.session.blob(a.root, a.root)).rejects.toThrow('SHA-256');
  expect(h.calls).toHaveLength(2); expect(h.session.stats().verifiedBlobs).toBe(0);
});

test('byte cache is bounded while verified descendant membership survives eviction', async () => {
  const h = harness(), size = 2 * 1024 ** 2;
  const chunks = await Promise.all(Array.from({ length: 17 }, async (_, i) => {
    const bytes = new Uint8Array(size); bytes[0] = i; const hash = await hashOf(bytes); h.blobs.set(hash, bytes); return { hash, size, type: LinkType.Blob };
  }));
  const node = await encodeAndHash({ type: LinkType.File, links: chunks.map((chunk) => ({ ...chunk, hash: fromHex(chunk.hash) })) });
  const root = toHex(node.hash); h.blobs.set(root, node.data);
  h.session.acceptAnnouncement(mapAnnouncement(offer(root, size * chunks.length, 'large', size), key));
  await h.session.blob(root, root);
  for (const chunk of chunks) await h.session.blob(chunk.hash, root);
  const calls = h.calls.length;
  await h.session.blob(chunks[0]!.hash, root);
  expect(h.calls).toHaveLength(calls + 1); // Evicted bytes, retained proof, no ancestor reread.
  await h.session.blob(chunks[0]!.hash, root); expect(h.calls).toHaveLength(calls + 1);
});

test('withdrawal revokes verified cache, aborts reads and rejects replay after discovery refresh', async () => {
  const h = harness(), a = await leaf(h); await h.session.blob(a.root, a.root);
  expect(h.session.acceptDeletion(deletion([['a', `30064:${publisher}:atlas/a`]]))).toBe(true);
  await expect(h.session.blob(a.root, a.root)).rejects.toThrow('active signed');
  await h.session.refresh(); expect(h.session.acceptAnnouncement(a.event)).toBe(false);
  const fresh = mapAnnouncement(a.map, key, now() + 1);
  expect(h.session.acceptAnnouncement(fresh)).toBe(true);
  const deferred = Promise.withResolvers<Uint8Array | null>(); let transportSignal: AbortSignal | undefined;
  h.client.fetchBlob = async (_hash, _providers, signal) => { transportSignal = signal; return deferred.promise; };
  const read = h.session.blob(a.root, a.root); void read.catch(() => {});
  h.session.acceptDeletion(deletion([['a', `30064:${publisher}:atlas/a`]], now() + 2));
  await expect(read).rejects.toThrow(); expect(transportSignal!.aborted).toBe(true);
  deferred.resolve(a.bytes); expect(h.session.stats().cancelledRequests).toBe(1);
});

test('event-id tombstones arriving before offers and stale revisions stay rejected across relays', async () => {
  const subscriptions: Parameters<typeof watchMaps>[] = [];
  const h = harness(async (...args) => { subscriptions.push(args); return () => {}; });
  await h.session.refresh();
  const map = offer('a'.repeat(64), 3), event = mapAnnouncement(map, key);
  subscriptions[0]![6]!.deleted!(deletion([['e', event.id]]));
  expect(h.session.acceptAnnouncement(event)).toBe(false);
  const fresh = mapAnnouncement({ ...map, hashtree: { ...map.hashtree!, root: 'b'.repeat(64) }, url: `htree://${'b'.repeat(64)}` }, key, now() + 2);
  expect(h.session.acceptAnnouncement(fresh)).toBe(true);
  expect(h.session.acceptAnnouncement(mapAnnouncement(map, key, now() + 1))).toBe(false);
  expect(h.session.acceptDeletion(deletion([['a', `30064:${publisher}:atlas/a`]], now() + 1))).toBe(true);
  expect(h.session.status().catalog[0]!.offer.hashtree!.root).toBe('b'.repeat(64));
  expect(h.session.acceptDeletion(deletion([['a', `30064:${publisher}:atlas/a`]], now() + 3, generateSecretKey()))).toBe(false);
});

test('same-second revision ordering uses the lowest event ID and survives refresh', async () => {
  const h = harness(); const a = offer('a'.repeat(64), 3), b = offer('b'.repeat(64), 3);
  const events = [mapAnnouncement(a, key), mapAnnouncement(b, key)].sort((a, b) => a.id.localeCompare(b.id));
  expect(h.session.acceptAnnouncement(events[1])).toBe(true); expect(h.session.acceptAnnouncement(events[0])).toBe(true);
  await h.session.refresh(); expect(h.session.acceptAnnouncement(events[1])).toBe(false);
});

test('expired offer revokes cached reads even when no relay sends a withdrawal', async () => {
  const h = harness(), a = await leaf(h); await h.session.blob(a.root, a.root);
  const time = spyOn(Date, 'now').mockReturnValue((now() + 8 * 86400) * 1000);
  try { await expect(h.session.blob(a.root, a.root)).rejects.toThrow('active signed'); expect(h.session.status().catalog).toHaveLength(0); }
  finally { time.mockRestore(); }
});

test('RPC pins root and provider, allows known map operations, and blocks administrative paths', async () => {
  const h = harness(), a = await leaf(h);
  await h.session.request(a.root, { path: 'capabilities', method: 'GET' });
  await h.session.request(a.root, { path: 'members/m0/search', method: 'POST', body: { query: 'Vienna' } });
  expect(h.rpc[0]).toMatchObject({ provider, request: { root: a.root, path: 'capabilities', method: 'GET' } });
  for (const request of [ { path: 'admin', method: 'POST' }, { path: '../admin', method: 'POST' },
    { path: 'https://host/route', method: 'POST' }, { path: 'route', method: 'GET' },
    { path: 'capabilities', method: 'GET', body: {} }, { path: 'route', method: 'POST', root: 'f'.repeat(64) },
    { path: 'route', method: 'POST', providerPeerId: '03' + 'c'.repeat(64) } ])
    await expect(h.session.request(a.root, request as never)).rejects.toThrow();
  expect(h.rpc).toHaveLength(2);
});

test('caller cancellation reaches transport and never caches late bytes; close is idempotent', async () => {
  const h = harness(), a = await leaf(h), deferred = Promise.withResolvers<Uint8Array | null>();
  let transportSignal: AbortSignal | undefined;
  h.client.fetchBlob = async (_hash, _providers, signal) => { transportSignal = signal; return deferred.promise; };
  const abort = new AbortController(), read = h.session.blob(a.root, a.root, abort.signal);
  void read.catch(() => {}); abort.abort(new DOMException('cancelled', 'AbortError')); await expect(read).rejects.toThrow();
  expect(transportSignal!.aborted).toBe(true); deferred.resolve(a.bytes);
  await Promise.resolve(); expect(h.session.stats()).toMatchObject({ pending: 0, cancelledRequests: 1, verifiedBlobs: 0 });
  await h.session.close(); await h.session.close(); expect(h.stopped()).toBe(1); expect(h.session.status().state).toBe('closed');
});

test('refresh can recover discovery and suppresses obsolete subscription callbacks', async () => {
  const callbacks: Parameters<typeof watchMaps>[] = []; let fail = true;
  const h = harness(async (...args) => { callbacks.push(args); if (fail) throw Error('Unavailable'); args[6]?.ready?.(); return () => {}; });
  expect((await h.session.refresh()).state).toBe('error'); fail = false;
  expect((await h.session.refresh()).discovery.ready).toBe(true); expect(callbacks[0]![3].aborted).toBe(true);
  const map = offer('a'.repeat(64), 3), event = mapAnnouncement(map, key);
  callbacks[0]![2](map, event); expect(h.session.status().catalog).toHaveLength(0);
  callbacks[1]![2](map, event); expect(h.session.status().catalog).toHaveLength(1);
});

test('signed view is exposed only while every referenced map root remains accepted', async () => {
  const h = harness(), a = await leaf(h), recipe = { version: 1 as const, id: 'view', name: 'Map view', coverage: true,
    sources: [{ url: a.map.url, root: a.root, enabled: true, layers: [] as [], labels: false }], presentation: defaultPresentation() };
  expect(h.session.acceptView(viewAnnouncement(recipe, generateSecretKey()))).toBe(false);
  expect(h.session.acceptView(viewAnnouncement(recipe, key))).toBe(true); expect(h.session.status().defaultView?.id).toBe('view');
  h.session.acceptDeletion(deletion([['e', a.event.id]])); expect(h.session.status().defaultView).toBeUndefined();
});

test('shared watchMaps reports authenticated unknown event-id deletion for cross-relay guards', async () => {
  const relay = localRelay(), abort = new AbortController(), observed = Promise.withResolvers<Event>();
  const event = deletion([['e', 'a'.repeat(64)]]);
  try {
    await publishAnnouncement(relay.url, event);
    await watchMaps(relay.url, [publisher], () => {}, abort.signal, () => {}, undefined, { deleted: observed.resolve });
    expect((await observed.promise).id).toBe(event.id);
  } finally { abort.abort(); relay.close(); }
});

test('view expiration and both NIP-9 deletion forms survive refresh without reviving older views', async () => {
  const h = harness(), a = await leaf(h), recipe = { version: 1 as const, id: 'view', name: 'Map view', coverage: true,
    sources: [{ url: a.map.url, root: a.root, enabled: true, layers: [] as [], labels: false }], presentation: defaultPresentation() };
  const base = viewAnnouncement(recipe, key);
  const expired = finalizeEvent({ kind: base.kind, created_at: base.created_at, content: base.content,
    tags: [...base.tags, ['expiration', String(now() - 1)]] }, key);
  expect(h.session.acceptView(expired)).toBe(false); expect(h.session.status().defaultView).toBeUndefined();
  const current = viewAnnouncement(recipe, key, now() + 1);
  expect(h.session.acceptView(current)).toBe(true);
  h.session.acceptDeletion(deletion([['a', `30065:${publisher}:atlas-view/view`]], now() + 2));
  expect(h.session.status().defaultView).toBeUndefined(); await h.session.refresh(); expect(h.session.acceptView(current)).toBe(false);
  const later = viewAnnouncement(recipe, key, now() + 3);
  expect(h.session.acceptView(later)).toBe(true);
  h.session.acceptDeletion(deletion([['e', later.id]], now() + 4)); expect(h.session.status().defaultView).toBeUndefined();
  const unknown = viewAnnouncement({ ...recipe, id: 'unknown' }, key);
  h.session.acceptDeletion(deletion([['e', unknown.id]])); expect(h.session.acceptView(unknown)).toBe(false);
});

test('newer unsupported signed map revision removes the stale accepted revision', async () => {
  const h = harness(), a = await leaf(h);
  const newer = { ...a.map, hashtree: { ...a.map.hashtree!, fips: [{ ...provider, rpcPort: 4444 }] } };
  expect(h.session.acceptAnnouncement(mapAnnouncement(newer, key, now() + 1))).toBe(false);
  expect(h.session.status().catalog).toHaveLength(0); expect(h.session.acceptAnnouncement(a.event)).toBe(false);
});

test('RPC does not replay uncertain operations or switch providers after offer reorder', async () => {
  const h = harness(), a = await leaf(h), mirror = { ...provider, peerId: '03' + 'c'.repeat(64) };
  const publish = (providers: typeof provider[], time: number) => h.session.acceptAnnouncement(mapAnnouncement({ ...a.map,
    hashtree: { ...a.map.hashtree!, fips: providers } }, key, time));
  publish([provider, mirror], now() + 1);
  await h.session.request(a.root, { path: 'capabilities', method: 'GET' });
  publish([mirror, provider], now() + 2);
  await h.session.request(a.root, { path: 'capabilities', method: 'GET' });
  expect(h.rpc.map((call) => call.provider.peerId)).toEqual([provider.peerId, provider.peerId]);
  let calls = 0; h.client.request = async () => { calls++; throw Error('Response lost'); };
  await expect(h.session.request(a.root, { path: 'offline', method: 'POST', body: {} })).rejects.toThrow('Response lost');
  expect(calls).toBe(1);
  publish([mirror], now() + 3);
  await expect(h.session.request(a.root, { path: 'capabilities', method: 'GET' })).rejects.toThrow('withdrawn'); expect(calls).toBe(1);
});
