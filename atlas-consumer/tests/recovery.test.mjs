import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const [mainSource, compositionSource, rendererSource, verifySource] = await Promise.all([
  read('../src/main.ts'), read('../src/composition.ts'),
  read('../../packages/renderer/src/composition.ts'), read('../../packages/hashtree/src/published-map.ts'),
]);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function moduleOf(source, globals = {}) {
  const module = { exports: {} };
  runInNewContext(compile(source), { module, exports: module.exports, ...globals });
  return module.exports;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const layers = ['land', 'water', 'buildings', 'roads', 'railways', 'peaks'];
const publisher = 'a'.repeat(64);
const entry = (id, char = '1', raster = false) => ({ key: `${publisher}:${id}@${char.repeat(64)}`, publisher,
  offer: { id, url: `htree://${char.repeat(64)}`, bytes: 1024,
    hashtree: { version: 1, root: char.repeat(64), bytes: 1024, chunkBytes: 65536, providers: [] },
    manifest: { name: id, snapshot: char.repeat(64), bounds: [10, 45, 11, 46], minZoom: 0, maxZoom: 14,
      capabilities: ['map', 'map-labels'], tileLayers: raster ? [] : layers,
      ...(raster ? { rasters: [{ id: 'imagery' }] } : {}) } } });
const stats = () => ({ networkRequests: 0, retries: 0, fipsBytes: 0, verifiedBlobs: 0, cacheHits: 0,
  errors: 0, cancelledRequests: 0, activeTransfers: 0, queuedTransfers: 0 });
const status = (catalog, extra = {}) => ({ version: 2, state: 'ready', catalog, preferredMapIds: [],
  discovery: { ready: true, settled: true, publishers: [publisher], relayUrls: ['wss://example.test'], messages: [] },
  requestTimeoutMs: 100000, stats: stats(), ...extra });
const readyStats = () => ({ zoom: 14, tiles: 4, wanted: 4, missing: 0, triangles: 240, sources: 1,
  fallbackTiles: 0, drawMs: 2, loading: 0, labels: { roads: 0, pois: 0, missing: 0, loading: 0 } });
const { verifyPublishedMap } = moduleOf(verifySource);

function harness({ failOpening = false, deferred = false, catalog = [entry('west')] } = {}) {
  const readers = [], sources = [], errors = [], pending = [];
  const metadata = new Map(catalog.map(e => [e.offer.hashtree.root, e.offer.manifest]));
  class Source {
    constructor(url, tree, _api, options) {
      assert.match(url, /^htree:\/\/[a-f0-9]{64}$/);
      this.url = url; this.tree = tree; this.options = options; sources.push(this);
    }
  }
  class Reader {
    cacheHits = 0; disposed = 0; opens = 0;
    constructor(source, onRead, options) { this.source = source; this.options = options; readers.push(this); }
    async open() {
      this.opens++;
      if (deferred) await new Promise(resolve => pending.push(resolve));
      if (failOpening) { failOpening = false; throw new Error('Initial timeout'); }
      this.index = { header: { fileLength: 1024 }, manifest: metadata.get(this.source.tree.root) };
      return this;
    }
    dispose() { this.disposed++; }
  }
  const map = { center: [0.2, 0.3], zoom: 14, cache: new Map([['tile', 'mesh']]), sources: [],
    fits: 0, retries: 0, styles: [], labelCalls: [],
    setLabels(...value) { this.labelCalls.push(value); }, setLayers(value) { this.layers = value; },
    setSources(value) { this.sources = value; }, setStyle(value) { this.styles.push(value); },
    fit() { this.fits++; }, setOffline(value) { assert.equal(value, false); this.retries++; } };
  const imports = specifier => {
    if (specifier.endsWith('/format/src/reader')) return { AtlasReader: Reader };
    if (specifier.endsWith('/hashtree/src/reader')) return { HashtreeReader: Source };
    if (specifier.endsWith('/published-map')) return { verifyPublishedMap };
    if (specifier.endsWith('/format/src/index')) return { MAP_LAYERS: layers };
    throw new Error(`Unexpected import: ${specifier}`);
  };
  const exports = moduleOf(compositionSource, { require: imports });
  const bridge = { blob() { throw new Error('Unexpected automatic blob callback'); } };
  const controller = new exports.MapComposition(map, bridge, () => {}, message => errors.push(message), () => {});
  return { controller, exports, imports, map, readers, sources, errors, pending, metadata, bridge };
}

test('composition starts with every geometry layer, no labels, imagery or tool purposes', async () => {
  const a = entry('west'), b = entry('east', '2'), h = harness({ catalog: [a, b] });
  h.controller.setCatalog(status([a, b], { preferredMapIds: ['west', 'east'], defaultView: {
    sources: [{ root: a.offer.hashtree.root, enabled: true }],
    presentation: { style: { name: 'Signed paint' }, layers: ['water'], labels: { places: true, streets: true, pois: true }, tools: ['routing', 'search', 'features'] },
  } }));
  await settle();
  assert.equal(h.map.sources.length, 2);
  for (const source of h.map.sources) {
    assert.deepEqual(Array.from(source.layers), layers);
    assert.equal(source.labels, false); assert.equal(source.rasterOpacity, 0);
  }
  for (const reader of h.readers) assert.deepEqual(Array.from(reader.options.purposes), ['map']);
  assert.deepEqual(h.map.labelCalls, [[false, false, false]]);
  assert.equal(h.map.styles[0].name, 'Signed paint');
  h.controller.setLabels({ places: true, streets: false, pois: false });
  assert.deepEqual(Array.from(h.readers[0].options.purposes), ['map', 'labels']);
  h.controller.setImagery(true);
  assert.equal(h.map.sources[0].rasterOpacity, 0.7);
  h.controller.setLabels({ places: false, streets: false, pois: false });
  assert.deepEqual(Array.from(h.readers[0].options.purposes), ['map']);
});

test('incremental discovery collects preferred maps and late signed paint without enabling additional reads', async () => {
  const a = entry('west'), b = entry('east', '2'), raster = entry('satellite', '3', true), h = harness({ catalog: [a, b, raster] });
  const discovering = { preferredMapIds: ['west', 'east'], discovery: { ready: false } };
  h.controller.setCatalog(status([raster], discovering));
  assert.equal(h.readers.length, 0);
  h.controller.setCatalog(status([raster, a], discovering));
  await settle(); assert.equal(h.map.sources.length, 1); assert.equal(h.map.fits, 0);
  h.controller.setCatalog(status([raster, a, b], { preferredMapIds: ['west', 'east'], defaultView: { sources: [], presentation: { style: { name: 'Late view' } } } }));
  await settle();
  assert.deepEqual(Array.from(h.map.sources, s => s.id), [a.key, b.key]);
  assert.equal(h.map.fits, 1); assert.equal(h.map.styles.at(-1).name, 'Late view');
  h.controller.select(b, false);
  h.controller.setCatalog(status([raster, a, b], { preferredMapIds: ['west', 'east'] }));
  assert.deepEqual(Array.from(h.map.sources, s => s.id), [a.key], 'user selection has authority over later defaults');
});

test('late view resolves source roots, and fallback prefers vector maps to imagery', async () => {
  const a = entry('west'), b = entry('east', '2'), raster = entry('satellite', '3', true), h = harness({ catalog: [a, b, raster] });
  h.controller.setCatalog(status([raster, a])); await settle();
  assert.deepEqual(Array.from(h.map.sources, s => s.id), [a.key]);
  h.controller.setCatalog(status([raster, a, b], { defaultView: { sources: [{ root: b.offer.hashtree.root, enabled: true }], presentation: { style: {} } } }));
  await settle(); assert.deepEqual(Array.from(h.map.sources, s => s.id), [b.key]);
});

test('retry preserves camera, source, reader and caches including initial open failure', async () => {
  const a = entry('west'), h = harness({ failOpening: true });
  h.controller.setCatalog(status([a])); await settle();
  const reader = h.readers[0], cache = h.map.cache;
  assert.equal(h.map.sources.length, 0); assert.match(h.errors[0], /Initial timeout/);
  h.controller.retry(); await settle();
  assert.equal(h.readers.length, 1); assert.equal(reader.opens, 2); assert.equal(reader.disposed, 0);
  assert.equal(h.map.sources.length, 1); assert.equal(h.map.retries, 1);
  assert.deepEqual(h.map.center, [0.2, 0.3]); assert.equal(h.map.zoom, 14); assert.equal(h.map.cache, cache);
  h.controller.retry(); await settle(); assert.equal(h.readers.length, 1); assert.equal(reader.opens, 2);
});

test('revision replaces only its selected source and withdrawal detaches/disposes it', async () => {
  const a = entry('west'), b = entry('east', '2'), revised = entry('west', '4'), h = harness({ catalog: [a, b, revised] });
  h.controller.setCatalog(status([a, b], { preferredMapIds: ['west', 'east'] })); await settle();
  const [old, retained] = h.readers;
  h.controller.setCatalog(status([revised, b], { preferredMapIds: ['west', 'east'] })); await settle();
  assert.equal(old.disposed, 1); assert.equal(retained.disposed, 0);
  assert.equal(h.map.sources[1].reader, retained); assert.equal(h.map.sources[0].id, revised.key);
  assert.equal(h.map.fits, 1, 'a revision preserves the established camera');
  h.controller.setCatalog(status([b], { preferredMapIds: ['west', 'east'] }));
  assert.equal(h.readers[2].disposed, 1); assert.deepEqual(Array.from(h.map.sources, s => s.id), [b.key]);
});

test('withdrawal and disposal reject late directory completions without reviving sources', async () => {
  const a = entry('west'), h = harness({ deferred: true });
  h.controller.setCatalog(status([a]));
  h.controller.setCatalog(status([]));
  assert.equal(h.readers[0].disposed, 1);
  h.pending.shift()(); await settle(); assert.equal(h.map.sources.length, 0);
  h.controller.setCatalog(status([a]));
  h.controller.dispose(); h.pending.shift()(); await settle();
  assert.equal(h.map.sources.length, 0); assert.equal(h.readers[1].disposed, 1); assert.deepEqual(h.errors, []);
  h.controller.retry(); assert.equal(h.map.retries, 0);
});

async function consumer(initial = status([entry('west')])) {
  const h = harness({ catalog: initial.catalog }), elements = new Map(), listeners = {}, maps = [], body = { dataset: {} };
  class Element {
    textContent = ''; hidden = false; disabled = false; checked = false; children = []; handlers = {};
    set id(value) { elements.set(value, this); }
    addEventListener(type, listener) { this.handlers[type] = listener; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
  }
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let bridge;
  class Bridge {
    constructor(changed) { this.changed = changed; bridge = this; }
    async status() { return initial; }
    async refresh() { return initial; }
    dispose() {}
  }
  class Renderer {
    static async create(_canvas, stats, error) {
      Object.assign(h.map, { stats, error, destroyed: 0, destroy() { this.destroyed++; }, zoomBy() {}, invalidate() {} });
      maps.push(h.map); return h.map;
    }
  }
  moduleOf(mainSource, { Uint8Array, atob,
    document: { getElementById: element, createElement: () => new Element(), createTextNode: value => value, body },
    window: { addEventListener(type, listener) { listeners[type] = listener; } },
    require(specifier) {
      if (specifier === './composition') return h.exports;
      if (specifier.endsWith('/renderer/src/composition')) return { CompositionMap: Renderer };
      if (specifier.endsWith('/atlas_renderer')) return { initSync: () => {} };
      if (specifier === 'atlas-renderer-wasm') return { default: 'AA==' };
      if (specifier === './bridge') return { PreviewBridge: Bridge };
      if (specifier === './styles.css' || specifier === './napplet-settings') return {};
      return h.imports(specifier);
    },
  });
  await settle(); return { ...h, element, maps, bridge, listeners, body };
}

test('recovery banner clears only after the selected composition finishes, not 0/0 or incomplete labels', async () => {
  const ui = await consumer(), map = ui.map;
  map.error(entry('west').key, 'TCP/FIPS read timed out');
  assert.match(ui.element('status').textContent, /Some map data could not load/);
  ui.element('retry').handlers.click(); await settle();
  assert.equal(map.retries, 1); assert.equal(ui.maps.length, 1); assert.equal(ui.readers.length, 1);
  for (const incomplete of [{ tiles: 0, wanted: 0 }, { loading: 1 }, { labels: { loading: 0, missing: 1 } }]) {
    map.stats({ ...readyStats(), ...incomplete }); assert.equal(ui.element('error').hidden, false);
  }
  map.stats(readyStats()); assert.equal(ui.element('error').hidden, true); assert.equal(ui.element('retry').hidden, true);
});

test('closed renderer and withdrawn source callbacks cannot alter recovery UI', async () => {
  const ui = await consumer(), map = ui.map;
  map.error('withdrawn-id', 'Late removed map error'); assert.equal(ui.element('error').hidden, true);
  map.error(entry('west').key, 'Current failure');
  ui.listeners.pagehide(); map.stats(readyStats()); map.error(entry('west').key, 'Late failure');
  assert.equal(ui.element('error').hidden, false); assert.equal(ui.element('error').textContent, 'Current failure');
  assert.equal(map.destroyed, 1); assert.equal(ui.readers[0].disposed, 1);
});

test('renderer retry keeps camera and retained sessions while clearing transfer failures', () => {
  const { CompositionMap } = moduleOf(rendererSource, { require: () => ({}) });
  const map = Object.create(CompositionMap.prototype), retried = [];
  const reader = { offline: true, cache: new Map([['tile', 'decoded']]) };
  const session = { source: { reader }, placesFailed: true,
    scheduler: { retry: () => retried.push('tiles') }, raster: { retry: () => retried.push('raster') },
    labels: { retry: () => retried.push('labels') }, placesView: { retry: () => retried.push('places') } };
  Object.assign(map, { sessions: new Map([['one', session]]), center: [0.2, 0.3], zoom: 14,
    invalidate: () => retried.push('invalidate') });
  map.setOffline(false);
  assert.deepEqual(retried, ['tiles', 'raster', 'labels', 'places', 'invalidate']);
  assert.equal(reader.offline, false); assert.equal(reader.cache.get('tile'), 'decoded');
  assert.deepEqual(map.center, [0.2, 0.3]); assert.equal(map.zoom, 14); assert.equal(session.placesFailed, false);
});

test('partial discovery selects and fits usable maps, shows ready UI, and retains its refresh warning', async () => {
  const warning = 'OUTBOX_READ: Query timed out before EOSE. Discovery may be incomplete; refresh to retry.';
  const partial = status([entry('west')]);
  partial.discovery = { ...partial.discovery, ready: false, settled: true, messages: [warning] };
  const ui = await consumer(partial);
  assert.equal(ui.map.sources.length, 1);
  assert.equal(ui.map.fits, 1);
  ui.map.stats(readyStats());
  assert.equal(ui.body.dataset.state, 'ready');
  assert.equal(ui.element('map-name').textContent, 'west');
  assert.equal(ui.element('error').hidden, true);
  assert.match(ui.element('discovery').textContent, /discovery incomplete/);
  assert.equal(ui.element('discovery-notes').textContent, warning);
  assert.equal(ui.element('refresh').disabled, false);
  ui.map.error(entry('west').key, 'Map transfer failed');
  assert.equal(ui.element('error').hidden, false);
  ui.element('retry').handlers.click(); await settle();
  ui.map.stats(readyStats());
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.body.dataset.state, 'ready');
  assert.equal(ui.element('discovery-notes').textContent, warning);
});
test('an explicit selection fits while discovery is still pending', async () => {
  const a = entry('west'), h = harness();
  h.controller.setCatalog(status([a], { state: 'discovering', discovery: { ready: false, settled: false } }));
  assert.equal(h.readers.length, 0);
  h.controller.select(a, true); await settle();
  assert.equal(h.map.sources.length, 1); assert.equal(h.map.fits, 1);
});
test('empty failed discovery remains fatal until verified offers become usable', async () => {
  const empty = status([], { state: 'error', error: 'OUTBOX_READ: Query timed out before EOSE' });
  empty.discovery = { ...empty.discovery, ready: false, settled: true, messages: [empty.error] };
  const ui = await consumer(empty);
  assert.equal(ui.map.sources.length, 0); assert.equal(ui.map.fits, 0);
  assert.equal(ui.element('error').hidden, false);
  assert.equal(ui.body.dataset.state, 'error');
  const partial = status([entry('west')]);
  partial.discovery = { ...empty.discovery, messages: ['Discovery may be incomplete; refresh to retry.'] };
  ui.metadata.set(entry('west').offer.hashtree.root, entry('west').offer.manifest);
  ui.bridge.changed(partial); await settle(); ui.map.stats(readyStats());
  assert.equal(ui.map.sources.length, 1); assert.equal(ui.map.fits, 1);
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.body.dataset.state, 'ready');
});
