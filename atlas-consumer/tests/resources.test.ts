import { afterEach, expect, spyOn, test } from 'bun:test';
import { encodePackage } from '../../packages/format/src/writer';
import { AtlasReader, FileSource } from '../../packages/format/src/reader';
import { sha256 } from '../../packages/format/src/index';
import { MapComposition } from '../src/composition';
import type { CompositionMap, CompositionMapSource } from '../../packages/renderer/src/composition';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { mapAnnouncement } from '../../packages/hashtree/src/announcement';
import { viewAnnouncement } from '../../packages/views/src/announcement';
import { defaultPresentation } from '../../packages/views/src/index';
import type { MapOffer } from '../../packages/format/src/catalog';
import { SignedMapLibrary } from '../src/signed-map-library';
import { PreviewBridge } from '../src/bridge';
import type { FipsBinding } from '../src/vendor/fips-resource-client';

const key = generateSecretKey(),
  publisher = getPublicKey(key);
const configuration = { publisher, relayUrls: ['wss://relay.example/'], mapIds: [] };
const provider = {
  peerId: '02' + 'b'.repeat(64),
  seedUrls: ['wss://seed.example/fips'],
  servicePort: 39018,
  rpcPort: 39019,
};
const now = () => Math.floor(Date.now() / 1000);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function offer(root = 'a'.repeat(64), id = 'a', peer = provider): MapOffer {
  return {
    id,
    url: `htree://${root}`,
    bytes: 3,
    hashtree: { version: 1, root, bytes: 3, chunkBytes: 65536, providers: [], fips: [peer] },
    manifest: {
      format: 'atlas',
      version: 1,
      name: id,
      snapshot: 'd'.repeat(64),
      bounds: [0, 0, 1, 1],
      minZoom: 0,
      maxZoom: 2,
      features: 0,
      peaks: 0,
      places: [],
      capabilities: [],
      limitations: [],
      source: { url: 'https://source.example', sha256: 'd'.repeat(64), attribution: 'Test' },
    },
  };
}
function library() {
  const value = new SignedMapLibrary(configuration);
  cleanup.push(() => value.close());
  return value;
}
const deletion = (tags: string[][], time = now(), secret = key) =>
  finalizeEvent({ kind: 5, content: '', tags, created_at: time }, secret);

test('signed discovery validates publishers, signatures and providers, with no HTTP delivery hints', () => {
  const l = library(),
    a = offer();
  const event = mapAnnouncement(a, key);
  expect(l.accept(mapAnnouncement(a, generateSecretKey()))).toBe(false);
  expect(
    l.accept({ ...event, content: event.content.replace('"name":"a"', '"name":"evil"') }),
  ).toBe(false);
  expect(
    l.accept(
      mapAnnouncement(
        { ...a, hashtree: { ...a.hashtree!, fips: [{ ...provider, servicePort: 4444 }] } },
        key,
      ),
    ),
  ).toBe(false);
  expect(
    l.accept(
      mapAnnouncement(
        {
          ...a,
          url: 'https://unused.example/map',
          api: 'https://unused.example/api',
          hashtree: { ...a.hashtree!, providers: ['https://unused.example/blobs'] },
        },
        key,
        now() + 1,
      ),
    ),
  ).toBe(true);
  const entry = l.catalog().catalog[0]!;
  expect(entry.offer.url).toStartWith('htree:');
  expect(entry.offer.api).toBeUndefined();
  expect(entry.offer.hashtree!.providers).toEqual([]);
  entry.offer.hashtree!.fips![0]!.peerId = '03' + 'c'.repeat(64);
  expect(l.entry(a.hashtree!.root).offer.hashtree!.fips![0]!.peerId).toBe(provider.peerId);
});
test('deletions arriving before offers, stale revisions and same-second ties cannot resurrect withdrawn roots', () => {
  const l = library(),
    a = offer(),
    event = mapAnnouncement(a, key);
  l.accept(deletion([['e', event.id]]));
  expect(l.accept(event)).toBe(false);
  const events = [
    mapAnnouncement(a, key, now() + 1),
    mapAnnouncement(offer('b'.repeat(64)), key, now() + 1),
  ].sort((a, b) => a.id.localeCompare(b.id));
  expect(l.accept(events[1])).toBe(true);
  expect(l.accept(events[0])).toBe(true);
  expect(l.accept(events[1])).toBe(false);
  const root = l.catalog().catalog[0]!.offer.hashtree!.root,
    abort = l.entry(root).abort;
  l.accept(deletion([['a', `30064:${publisher}:atlas/a`]], now() + 2));
  expect(abort.signal.aborted).toBe(true);
  expect(l.catalog().catalog).toHaveLength(0);
  expect(l.accept(events[0])).toBe(false);
  expect(
    l.accept(deletion([['a', `30064:${publisher}:atlas/a`]], now() + 3, generateSecretKey())),
  ).toBe(false);
});
test('signed default composition waits for both roots and vanishes on expiry or withdrawal', () => {
  const l = library(),
    a = offer(),
    b = offer('b'.repeat(64), 'b');
  const recipe = {
    version: 1 as const,
    id: 'view',
    name: 'Two maps',
    coverage: true,
    sources: [a, b].map((o) => ({
      url: o.url,
      root: o.hashtree!.root,
      enabled: true,
      layers: [],
      labels: false,
    })),
    presentation: defaultPresentation(),
  };
  expect(l.accept(viewAnnouncement(recipe, generateSecretKey()))).toBe(false);
  expect(l.accept(viewAnnouncement(recipe, key))).toBe(true);
  l.accept(mapAnnouncement(a, key));
  expect(l.catalog().defaultView).toBeUndefined();
  l.accept(mapAnnouncement(b, key));
  expect(l.catalog().defaultView?.id).toBe('view');
  const clock = spyOn(Date, 'now').mockReturnValue((now() + 8 * 86400) * 1000);
  try {
    expect(l.catalog().catalog).toHaveLength(0);
    expect(l.catalog().defaultView).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
function harness(events = [mapAnnouncement(offer(), key)], result: { incomplete: boolean; error?: string } = { incomplete: false }) {
  const opens: Parameters<FipsBinding['open']>[0][] = [],
    reads: string[] = [],
    releases: string[] = [];
  const subscriptions: Map<string, (value: any) => void>[] = [];
  const resources: FipsBinding = {
    info: async () => ({
      profile: 'soy.fips/1',
      enabled: true,
      timeoutMs: 10000,
      stats: {
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
      },
    }),
    open: async (roots) => {
      opens.push(roots);
      return roots.map((r) => r.root);
    },
    bytes: async (grant) => {
      reads.push(grant);
      return new Uint8Array([1, 2, 3]);
    },
    request: async (grant) => ({
      status: 200,
      headers: { 'x-atlas-snapshot': grant },
      body: { root: grant },
    }),
    release: async (id) => {
      releases.push(id);
    },
    subscribe: () => () => {},
  };
  const outbox = {
    query: async () => ({ events: events.map((event) => ({ event })), ...result }),
    subscribe: () => {
      const listeners = new Map();
      subscriptions.push(listeners);
      return {
        on: (type: string, callback: any) => listeners.set(type, callback),
        close: () => {},
      };
    },
  };
  const bridge = new PreviewBridge(() => {}, { configuration, resources, outbox: outbox as never });
  cleanup.push(() => bridge.dispose());
  return { bridge, resources, outbox, opens, reads, releases, subscriptions };
}
test('OUTBOX discovery starts no data reads; two selected roots batch consent with independent providers', async () => {
  const a = offer(),
    b = offer('b'.repeat(64), 'b', { ...provider, peerId: '03' + 'c'.repeat(64) });
  const h = harness([mapAnnouncement(a, key), mapAnnouncement(b, key)]);
  expect((await h.bridge.status()).catalog).toHaveLength(2);
  expect(h.opens).toHaveLength(0);
  expect(h.reads).toHaveLength(0);
  await Promise.all([a, b].map((o) => h.bridge.blob(o.hashtree!.root, o.hashtree!.root)));
  expect(h.opens).toHaveLength(1);
  expect(h.opens[0]!.map((r) => r.providers[0]!.peerId)).toEqual([
    provider.peerId,
    b.hashtree!.fips![0]!.peerId,
  ]);
  await h.bridge.blob(a.hashtree!.root, a.hashtree!.root);
  expect(h.opens).toHaveLength(1);
  expect(
    (await h.bridge.request(a.hashtree!.root, { method: 'GET', path: 'capabilities' })).headers?.[
      'x-atlas-snapshot'
    ],
  ).toBe(a.hashtree!.root);
  await expect(h.bridge.blob('f'.repeat(64), 'f'.repeat(64))).rejects.toThrow('active signed');
});
test('withdrawal aborts outstanding reads and releases grants; obsolete subscriptions cannot revive them', async () => {
  const h = harness();
  await h.bridge.status();
  const root = offer().hashtree!.root;
  await h.bridge.blob(root, root);
  let signal: AbortSignal | undefined;
  h.resources.bytes = async (_id, _hash, options) => {
    signal = options?.signal;
    return new Promise((_, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
    );
  };
  const read = h.bridge.blob(root, root).then(
    () => false,
    () => true,
  );
  await Bun.sleep(0);
  h.subscriptions[0]!.get('event')!({ event: deletion([['a', `30064:${publisher}:atlas/a`]]) });
  expect(await read).toBe(true);
  expect(signal?.aborted).toBe(true);
  await Bun.sleep(0);
  expect(h.releases).toEqual([root]);
  await h.bridge.refresh();
  h.subscriptions[0]!.get('event')!({ event: mapAnnouncement(offer(), key, now() + 1) });
  expect((await h.bridge.status()).catalog).toHaveLength(0);
});
test('cancelled approval rejects caller promptly and disposal releases a late approval', async () => {
  const h = harness();
  await h.bridge.status();
  const deferred = Promise.withResolvers<string[]>();
  h.resources.open = () => deferred.promise;
  const abort = new AbortController(),
    root = offer().hashtree!.root;
  const read = h.bridge.blob(root, root, abort.signal).then(
    () => false,
    () => true,
  );
  await Bun.sleep(0);
  abort.abort();
  expect(await read).toBe(true);
  h.bridge.dispose();
  deferred.resolve(['late']);
  await Bun.sleep(0);
  expect(h.releases).toContain('late');
  expect(h.reads).toHaveLength(0);
  await expect(h.bridge.status()).rejects.toThrow();
});
test('closed discovery ignores late query results and a missing experimental profile explains the unavailable capability', async () => {
  const h = harness(),
    query = Promise.withResolvers<any>();
  h.outbox.query = () => query.promise;
  const status = h.bridge.status();
  await Bun.sleep(0);
  h.bridge.dispose();
  query.resolve({ events: [{ event: mapAnnouncement(offer(), key) }] });
  expect((await status).state).toBe('closed');
  const blocked = harness();
  blocked.resources.info = async () => ({
    profile: 'soy.fips/1',
    enabled: false,
    timeoutMs: 10000,
    stats: {
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
    },
  });
  await expect(blocked.bridge.status()).rejects.toThrow('Network settings');
});

const eoseError = 'OUTBOX_READ: Query timed out before EOSE';
test('signed partial discovery loads and fits verified map bytes while retaining the refresh warning', async () => {
  const { snapshot: _snapshot, ...manifest } = offer().manifest;
  const bytes = await encodePackage(manifest, []);
  const file = await new AtlasReader(new FileSource(new Blob([bytes]))).open();
  let composition: MapComposition | undefined;
  try {
    expect(bytes.length).toBeLessThan(65536);
    const tree = { root: await sha256(bytes), bytes: bytes.length, chunkBytes: 65536 };
    const a: MapOffer = { ...offer(tree.root), bytes: tree.bytes, manifest: file.index.manifest,
      hashtree: { ...offer().hashtree!, root: tree.root, bytes: tree.bytes, chunkBytes: tree.chunkBytes } };
    const event = mapAnnouncement(a, key);
    const unresolvedView = viewAnnouncement({ version: 1, id: 'missing', name: 'Missing map', coverage: false,
      sources: [{ url: 'htree://' + 'f'.repeat(64), root: 'f'.repeat(64), enabled: true, layers: [], labels: false }],
      presentation: defaultPresentation() }, key);
    const h = harness([event, unresolvedView, { ...event, content: 'tampered' }], { incomplete: true, error: eoseError });
    h.resources.bytes = async (_grant, hash) => {
      h.reads.push(hash);
      if (hash !== tree.root) throw new Error('Unknown fixture blob');
      return bytes;
    };
    const state = await h.bridge.status();
    expect(state.catalog).toHaveLength(1);
    expect(state.defaultView).toBeUndefined();
    expect(state.state).toBe('ready');
    expect(state.discovery.ready).toBe(false);
    expect(state.discovery.settled).toBe(true);
    expect(state.discovery.messages.join(' ')).toContain(eoseError);
    expect(state.discovery.messages.join(' ')).toMatch(/refresh/i);
    expect(state.error).toBeUndefined();
    expect(h.opens).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
    const sources: CompositionMapSource[][] = [], failures: string[] = [];
    let fits = 0;
    const renderer = { setLabels() {}, setLayers() {}, setStyle() {}, setSources(value: CompositionMapSource[]) { sources.push(value); }, fit() { fits++; } };
    composition = new MapComposition(renderer as unknown as CompositionMap, h.bridge, () => {}, message => failures.push(message), () => {});
    composition.setCatalog(state);
    for (let i = 0; i < 100 && composition.opening; i++) await Bun.sleep(1);
    expect(failures).toEqual([]);
    expect(composition.readyCount).toBe(1);
    expect(composition.active[0]?.offer.hashtree?.root).toBe(tree.root);
    expect(sources.at(-1)?.[0]?.manifest.snapshot).toBe(file.index.manifest.snapshot);
    expect(fits).toBe(1);
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]?.[0]?.root).toBe(tree.root);
    expect(h.reads.length).toBeGreaterThan(0);
    expect((await h.bridge.status()).discovery.messages.join(' ')).toContain(eoseError);
    h.subscriptions[0]!.get('event')!({ event: deletion([['e', event.id]]) });
    const withdrawn = await h.bridge.status();
    composition.setCatalog(withdrawn);
    expect(withdrawn.state).toBe('error');
    expect(withdrawn.catalog).toHaveLength(0);
    expect(composition.readyCount).toBe(0);
    expect(sources.at(-1)).toEqual([]);
  } finally {
    composition?.dispose(); file.dispose();
  }
});
test('incomplete discovery without usable signed offers remains a fatal, retryable discovery failure', async () => {
  const h = harness([mapAnnouncement(offer(), generateSecretKey())], { incomplete: true, error: eoseError });
  const state = await h.bridge.status();
  expect(state.catalog).toHaveLength(0);
  expect(state.state).toBe('error');
  expect(state.error).toBe(eoseError);
  expect(state.discovery.ready).toBe(false);
  expect(state.discovery.settled).toBe(true);
  expect(state.discovery.messages.join(' ')).toMatch(/refresh/i);
  expect(h.opens).toHaveLength(0);
  expect(h.reads).toHaveLength(0);
});

test('an incomplete empty query and a rejected query retain actionable discovery failure', async () => {
  const empty = harness([], { incomplete: true });
  const state = await empty.bridge.status();
  expect(state.state).toBe('error');
  expect(state.error).toMatch(/refresh/i);
  const streamed = harness();
  streamed.outbox.query = async () => {
    streamed.subscriptions[0]!.get('event')!({ event: mapAnnouncement(offer(), key) });
    throw new Error(eoseError);
  };
  const partial = await streamed.bridge.status();
  expect(partial.catalog).toHaveLength(1);
  expect(partial.state).toBe('ready');
  expect(partial.discovery.settled).toBe(true);
  expect(partial.discovery.ready).toBe(false);
  expect(partial.discovery.messages.join(' ')).toContain(eoseError);
  expect(streamed.opens).toHaveLength(0);
});
