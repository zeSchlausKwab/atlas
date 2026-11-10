import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const mapSource = await readFile(new URL('../../packages/renderer/src/map.ts', import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
const readyStats = () => ({ zoom: 14, tiles: 4, wanted: 4, missing: 0, triangles: 240,
  fallbackTiles: 0, drawMs: 2, loading: 0, labels: { roads: 0, pois: 0, missing: 0, loading: 0 } });

async function consumer({ failOpening = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false,
      handlers: {}, addEventListener(type, listener) { this.handlers[type] = listener; } });
    return elements.get(id);
  };
  const listeners = {};
  const maps = [], readers = [];
  let bridge;
  const status = { state: 'ready', providerPeerId: '02' + '1'.repeat(64), requestTimeoutMs: 253000,
    map: { name: 'Test map', rootHash: '2'.repeat(64), size: 1024, chunkBytes: 65536 } };
  class Reader {
    cacheHits = 0; disposed = 0;
    constructor() { readers.push(this); }
    async open() { if (failOpening) { failOpening = false; throw new Error('Initial timeout'); } }
    dispose() { this.disposed++; }
  }
  class MapView {
    static async create(_canvas, reader, stats, error) {
      const map = { reader, stats, error, center: [0.2, 0.3], zoom: 14, cache: new Map([['tile', 'mesh']]),
        retries: 0, destroyed: 0, retryLoads() { this.retries++; }, destroy() { this.destroyed++; } };
      maps.push(map); return map;
    }
  }
  class Bridge {
    constructor(changed) { this.changed = changed; bridge = this; }
    async status() { return status; }
    dispose() {}
  }
  const module = { exports: {} };
  runInNewContext(compile(mainSource), {
    module, exports: module.exports, Uint8Array, atob,
    document: { getElementById: element, body: { dataset: {} } },
    window: { addEventListener(type, listener) { listeners[type] = listener; } },
    require(specifier) {
      if (specifier.endsWith('/reader')) return { AtlasReader: Reader };
      if (specifier.endsWith('/source')) return { HashtreeSource: class {} };
      if (specifier.endsWith('/map')) return { AtlasMap: MapView };
      if (specifier.endsWith('/atlas_renderer')) return { default: async () => {} };
      if (specifier === 'atlas-renderer-wasm') return { default: 'AA==' };
      if (specifier === './bridge') return { PreviewBridge: Bridge };
      if (specifier === './styles.css') return {};
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  await settle();
  return { element, maps, readers, bridge, listeners };
}

test('retry preserves the map camera, reader and caches until the current view finishes', async () => {
  const ui = await consumer();
  const map = ui.maps[0], cache = map.cache;
  map.error('TCP/FIPS read timed out');
  assert.match(ui.element('status').textContent, /Some map data could not load/);
  assert.equal(ui.element('retry').textContent, 'Retry map loading');
  ui.element('retry').handlers.click();
  await settle();
  assert.equal(map.retries, 1);
  assert.equal(ui.maps.length, 1);
  assert.equal(ui.readers.length, 1);
  assert.equal(map.destroyed, 0);
  assert.equal(ui.readers[0].disposed, 0);
  assert.deepEqual(map.center, [0.2, 0.3]);
  assert.equal(map.zoom, 14);
  assert.equal(map.cache, cache);
  assert.equal(ui.element('error').hidden, false);
  map.stats({ ...readyStats(), tiles: 0, wanted: 0 });
  assert.equal(ui.element('error').hidden, false, '0/0 does not prove a recovered view');
  map.stats({ ...readyStats(), loading: 1 });
  assert.equal(ui.element('error').hidden, false);
  map.stats({ ...readyStats(), labels: { loading: 0, missing: 1 } });
  assert.equal(ui.element('error').hidden, false);
  map.stats(readyStats());
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.element('retry').hidden, true);
  assert.match(ui.element('status').textContent, /Reading over FIPS/);
});

test('closed map callbacks cannot clear or reintroduce the error banner', async () => {
  const ui = await consumer();
  const map = ui.maps[0];
  map.error('Current failure');
  ui.listeners.pagehide();
  map.stats(readyStats());
  assert.equal(ui.element('error').hidden, false);
  map.error('Late failure');
  assert.equal(ui.element('error').textContent, 'Current failure');
});

test('initial opening failure can still retry creating the map', async () => {
  const ui = await consumer({ failOpening: true });
  assert.equal(ui.maps.length, 0);
  assert.equal(ui.element('retry').textContent, 'Try connection');
  ui.element('retry').handlers.click();
  await settle();
  assert.equal(ui.maps.length, 1);
  assert.equal(ui.readers[0].disposed, 1);
});

test('renderer retry clears load failures without changing view or retained resources', () => {
  const module = { exports: {} };
  runInNewContext(compile(mapSource), { module, exports: module.exports, require: () => ({}) });
  const map = Object.create(module.exports.AtlasMap.prototype);
  const retried = [];
  const reader = { offline: false, cache: new Map([['tile', 'decoded']]) };
  Object.assign(map, { reader, center: [0.2, 0.3], zoom: 14, placesFailed: true,
    tiles: { retry: () => retried.push('tiles') }, raster: { retry: () => retried.push('raster') },
    labels: { retry: () => retried.push('labels') }, placesView: { retry: () => retried.push('places') },
    invalidate: () => retried.push('invalidate') });
  map.retryLoads();
  assert.deepEqual(retried, ['tiles', 'raster', 'labels', 'places', 'invalidate']);
  assert.equal(map.reader, reader);
  assert.equal(reader.cache.get('tile'), 'decoded');
  assert.deepEqual(map.center, [0.2, 0.3]);
  assert.equal(map.zoom, 14);
  assert.equal(map.placesFailed, false);
  retried.length = 0;
  map.setOffline(true);
  assert.equal(reader.offline, true);
  assert.deepEqual(retried, ['tiles', 'raster', 'labels', 'places', 'invalidate']);
  map.dead = true; retried.length = 0;
  map.retryLoads();
  assert.deepEqual(retried, []);
});
