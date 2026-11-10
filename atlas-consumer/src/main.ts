import './styles.css';
import { AtlasReader } from '../../packages/format/src/reader';
import { HashtreeSource } from '../../packages/hashtree/src/source';
import { AtlasMap, type MapStats } from '../../packages/renderer/src/map';
import init from '../../packages/renderer/pkg/atlas_renderer';
import wasmBase64 from 'atlas-renderer-wasm';
import { PreviewBridge, type PreviewStatus } from './bridge';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element ${id}`);
  return value as T;
}
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const power = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(power > 1 ? 2 : 1)} ${['B', 'KiB', 'MiB', 'GiB'][power]}`;
}
let map: AtlasMap | undefined;
let reader: AtlasReader | undefined;
let latest: Partial<PreviewStatus> = {};
let generation = 0;
let opening = false;
let failed = false;
const bridge = new PreviewBridge(update);
function update(status: Partial<PreviewStatus>) {
  latest = { ...latest, ...status };
  if (latest.stats) {
    const s = latest.stats;
    el('bytes').textContent = bytes(s.fipsBytes);
    el('blobs').textContent = s.verifiedBlobs.toLocaleString();
    el('reuse').textContent = `${s.cacheHits.toLocaleString()} bridge cache hits · ${reader?.cacheHits ?? 0} Atlas cache hits`;
    el('requests').textContent = `${s.networkRequests} FIPS requests · ${s.activeTransfers} active · ${s.queuedTransfers} queued · ${s.retries} retries · ${s.errors} errors · ${s.cancelledRequests} cancelled`;
  }
  if (latest.map) {
    el('map-name').textContent = latest.map.name;
    el('archive').textContent = `${bytes(latest.map.size)} · read only the needed parts`;
    el('root').textContent = latest.map.rootHash;
    el('provider').textContent = latest.providerPeerId ?? '';
  }
  if (latest.state === 'error') fail(latest.error ?? 'FIPS connection failed');
  else if (!failed && map) {
    el('status').textContent = 'Reading over FIPS · no HTTP map delivery';
    document.body.dataset.state = 'ready';
  } else if (!failed && latest.state === 'ready') {
    const s = latest.stats;
    el('status').textContent = s
      ? `Opening Atlas directory · ${s.verifiedBlobs} verified blobs · ${s.activeTransfers} active · ${s.queuedTransfers} queued${s.retries ? ` · ${s.retries} retries` : ''}`
      : 'FIPS node ready · opening Atlas directory…';
  }
}
function fail(message: string) {
  failed = true;
  el('status').textContent = map ? 'Some map data could not load · you can keep exploring' : 'Could not open the map · try the connection again';
  el('retry').textContent = map ? 'Retry map loading' : 'Try connection';
  el('error').textContent = message; el('error').hidden = false;
  el('retry').hidden = false; document.body.dataset.state = 'error';
}
function renderStats(s: MapStats) {
  el('zoom').textContent = `z${s.zoom.toFixed(1)}`;
  const loading = s.loading + s.labels.loading;
  const complete = s.wanted > 0 && s.tiles === s.wanted && s.missing === 0 && loading === 0 && s.labels.missing === 0;
  el('render-status').textContent = `${s.tiles}/${s.wanted} tiles · ${s.triangles.toLocaleString()} triangles${loading ? ' · receiving…' : complete ? ' · ready' : ' · partial view'}`;
  if (failed && complete && latest.state === 'ready') {
    failed = false;
    el('error').hidden = true; el('retry').hidden = true;
    update({});
  }
}
async function start() {
  if (opening) return;
  opening = true; failed = false;
  const run = ++generation;
  el('error').hidden = true; el('retry').hidden = true;
  map?.destroy(); map = undefined; reader?.dispose(); reader = undefined;
  document.body.dataset.state = 'starting';
  el('status').textContent = 'Connecting to the preview’s FIPS node…';
  try {
    const status = await bridge.status();
    if (run !== generation) return;
    update(status);
    if (status.state === 'error') throw new Error(status.error);
    const identity = `fips://${status.providerPeerId}/${status.map.rootHash}`;
    const source = new HashtreeSource(identity, {
      version: 1, root: status.map.rootHash, bytes: status.map.size,
      chunkBytes: status.map.chunkBytes, providers: [],
    }, undefined, {
      memoryBytes: 16 * 1024 ** 2,
      // The preview owns queue + FIPS attempt deadlines. Do not cut off its work
      // with the reader's shorter HTTP-oriented default.
      requestTimeoutMs: status.requestTimeoutMs + 1000,
      fetchBlob: (hash, signal) => bridge.blob(hash, status.providerPeerId, signal),
    });
    reader = new AtlasReader(source, () => { if (run === generation) update({}); }, { purposes: ['map', 'labels'] });
    await reader.open();
    const binary = Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0));
    await init({ module_or_path: binary });
    if (run !== generation) return;
    let createdMap: AtlasMap | undefined;
    const current = () => run === generation && createdMap !== undefined && map === createdMap;
    createdMap = await AtlasMap.create(el<HTMLCanvasElement>('map'), reader,
      (stats) => { if (current()) renderStats(stats); },
      (message) => { if (current()) fail(message); },
      { placeNames: true, streetNames: true, pois: false });
    if (run !== generation) { createdMap.destroy(); return; }
    map = createdMap;
    for (const id of ['zoom-in', 'zoom-out', 'fit']) el<HTMLButtonElement>(id).disabled = false;
    update({});
  } catch (error) { if (run === generation) fail(error instanceof Error ? error.message : String(error)); }
  finally { opening = false; }
}
el('zoom-in').addEventListener('click', () => map?.zoomBy(1));
el('zoom-out').addEventListener('click', () => map?.zoomBy(-1));
el('fit').addEventListener('click', () => map?.fit());
el('retry').addEventListener('click', () => {
  if (!map) { void start(); return; }
  map.retryLoads();
  el('status').textContent = 'Retrying missing map data…';
});
window.addEventListener('pagehide', () => { generation++; map?.destroy(); reader?.dispose(); bridge.dispose(); }, { once: true });
void start();
