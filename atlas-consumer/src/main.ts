import './napplet-settings';
import './styles.css';
import { MAP_LAYERS } from '../../packages/format/src/index';
import { CompositionMap, type CompositionStats } from '../../packages/renderer/src/composition';
import { initSync } from '../../packages/renderer/pkg/atlas_renderer';
import wasmBase64 from 'atlas-renderer-wasm';
import { PreviewBridge, type ConsumerStatus, type PreviewUpdate } from './bridge';
import { MapComposition } from './composition';

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
let map: CompositionMap | undefined;
let composition: MapComposition | undefined;
let latest: ConsumerStatus | undefined;
let generation = 0, opening = false, closed = false;
let failed: false | 'map' | 'discovery' = false;
const bridge = new PreviewBridge(update);
function diagnostics() {
  if (!latest) return;
  const s = latest.stats;
  el('bytes').textContent = bytes(s.fipsBytes);
  el('blobs').textContent = s.verifiedBlobs.toLocaleString();
  el('reuse').textContent = `${s.cacheHits.toLocaleString()} shell cache hits · ${composition?.cacheHits ?? 0} Atlas cache hits`;
  el('requests').textContent = `${s.networkRequests} FIPS requests · ${s.activeTransfers} active · ${s.queuedTransfers} queued · ${s.retries} retries · ${s.errors} errors · ${s.cancelledRequests} cancelled`;
}
function update(status: PreviewUpdate) {
  if (closed) return;
  if ('catalog' in status) {
    latest = status;
    composition?.setCatalog(status);
    el('discovery').textContent = `${status.catalog.length} signed maps · ${status.discovery.ready ? 'discovery current' : status.discovery.settled ? 'discovery incomplete' : 'discovering…'}`;
    el('publishers').textContent = status.discovery.publishers.join('\n');
    el('relays').textContent = status.discovery.relayUrls.join('\n');
    el('discovery-notes').textContent = status.discovery.messages.join(' · ');
    if (status.state === 'error') fail(status.error ?? 'FIPS discovery failed', 'discovery');
    else if (failed === 'discovery') clearFailure();
    if (status.state === 'closed') { fail('The resource session closed. Reopen the napplet to continue.'); shutdown(); }
  } else if (latest) latest.stats = status.stats;
  diagnostics(); connection();
}
function connection() {
  if (closed || failed) return;
  const active = composition?.active ?? [];
  el('map-name').textContent = active.length === 1 ? active[0].offer.manifest.name : active.length ? `${active.length} maps · one view` : 'Choose maps to explore';
  el('status').textContent = composition?.opening ? 'Opening selected Atlas directories over FIPS…'
    : active.length ? 'Reading over FIPS · geometry first'
    : latest?.catalog.length ? 'Select one or more signed maps below'
    : latest?.discovery.ready ? 'No signed maps found · refresh discovery to try again'
    : 'Discovering signed maps through OUTBOX…';
  document.body.dataset.state = composition?.readyCount ? 'ready' : 'starting';
}
function clearFailure() {
  failed = false; el('error').hidden = true; el('retry').hidden = true;
}
function fail(message: string, kind: 'map' | 'discovery' = 'map') {
  if (closed) return;
  failed = kind;
  el('status').textContent = kind === 'discovery' ? 'Could not discover signed maps · refresh to retry'
    : composition?.readyCount ? 'Some map data could not load · you can keep exploring' : 'Could not open selected maps · retry or refresh discovery';
  el('retry').textContent = kind === 'discovery' ? 'Refresh discovery' : map ? 'Retry map loading' : 'Try connection';
  el('error').textContent = message; el('error').hidden = false;
  el('retry').hidden = false; document.body.dataset.state = 'error';
}
function renderStats(s: CompositionStats) {
  el('zoom').textContent = `z${s.zoom.toFixed(1)}`;
  const complete = s.wanted > 0 && s.tiles === s.wanted && s.missing === 0 && s.loading === 0 && s.labels.loading === 0 && s.labels.missing === 0;
  el('render-status').textContent = `${s.sources} sources in view · ${s.tiles}/${s.wanted} tiles · ${s.triangles.toLocaleString()} triangles${s.loading ? ' · receiving…' : complete ? ' · ready' : ' · partial view'}`;
  if (failed === 'map' && complete && !composition?.errors.length && !composition?.opening && latest?.state !== 'error') {
    clearFailure(); connection();
  }
}
function renderCatalog() {
  if (!composition || closed) return;
  const list = el('catalog'); list.replaceChildren();
  const active = composition.active;
  const ordered = [...active, ...composition.catalog.filter(e => !composition!.isSelected(e))];
  for (const entry of ordered) {
    const row = document.createElement('div'); row.className = 'map-option';
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = composition.isSelected(entry);
    input.addEventListener('change', () => composition?.select(entry, input.checked));
    const copy = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = entry.offer.manifest.name;
    const detail = document.createElement('small');
    const imageryOnly = entry.offer.manifest.tileLayers?.length === 0 && !!entry.offer.manifest.rasters?.length;
    detail.textContent = `${composition.state(entry)} · ${bytes(entry.offer.bytes)}${imageryOnly ? ' · enable imagery to display' : ''}`;
    copy.append(title, detail); label.append(input, copy); row.append(label);
    if (input.checked) {
      const raise = document.createElement('button'); raise.type = 'button'; raise.textContent = '↑';
      raise.setAttribute('aria-label', `Move ${entry.offer.manifest.name} above other maps`);
      raise.disabled = active[0]?.key === entry.key;
      raise.addEventListener('click', () => composition?.raise(entry)); row.append(raise);
    }
    list.append(row);
  }
  el('selection').textContent = `${active.length} selected · first map has priority where coverage overlaps`;
  el('roots').textContent = active.map(e => `${e.offer.manifest.name}\n${e.offer.hashtree!.root}`).join('\n\n') || 'No map selected';
  el('provider').textContent = [...new Set(active.flatMap(e => e.offer.hashtree?.fips?.map(p => p.peerId) ?? []))].join('\n') || 'No active FIPS provider';
  diagnostics(); connection();
}
async function start() {
  if (opening || closed || map) return;
  opening = true; failed = false;
  const run = ++generation;
  el('error').hidden = true; el('retry').hidden = true;
  el('status').textContent = 'Discovering signed maps through the shell…';
  try {
    const status = await bridge.status();
    if (closed || run !== generation) return;
    update(status);
    if (closed) return;
    // Embedded bytes initialize WASM before CompositionMap's shared loader is called.
    initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) });
    if (closed || run !== generation) return;
    let created: CompositionMap | undefined;
    const current = () => !closed && run === generation && created !== undefined && map === created;
    created = await CompositionMap.create(el<HTMLCanvasElement>('map'),
      stats => { if (current()) renderStats(stats); },
      (id, message) => { if (current() && composition?.active.some(e => e.key === id)) fail(message); });
    if (closed || run !== generation) { created.destroy(); return; }
    map = created;
    composition = new MapComposition(map, bridge, renderCatalog, fail, diagnostics);
    composition.setLayers(MAP_LAYERS.filter(layer => el<HTMLInputElement>(`layer-${layer}`).checked));
    composition.setLabels({ places: el<HTMLInputElement>('labels-places').checked,
      streets: el<HTMLInputElement>('labels-streets').checked, pois: el<HTMLInputElement>('labels-pois').checked });
    composition.setImagery(el<HTMLInputElement>('imagery').checked);
    map.coverage = el<HTMLInputElement>('coverage').checked;
    composition.setCatalog(latest ?? status);
    for (const id of ['zoom-in', 'zoom-out', 'fit']) el<HTMLButtonElement>(id).disabled = false;
    connection();
  } catch (error) { if (!closed && run === generation) fail(error instanceof Error ? error.message : String(error)); }
  finally { opening = false; }
}
for (const layer of MAP_LAYERS) {
  const label = document.createElement('label'), input = document.createElement('input');
  input.type = 'checkbox'; input.checked = true; input.value = layer;
  input.addEventListener('change', () => composition?.setLayers(MAP_LAYERS.filter(l => el<HTMLInputElement>(`layer-${l}`).checked)));
  input.id = `layer-${layer}`; label.append(input, document.createTextNode(layer)); el('layers').append(label);
}
for (const label of ['places', 'streets', 'pois'] as const) el(`labels-${label}`).addEventListener('change', () => composition?.setLabels({
  places: el<HTMLInputElement>('labels-places').checked,
  streets: el<HTMLInputElement>('labels-streets').checked,
  pois: el<HTMLInputElement>('labels-pois').checked,
}));
el('imagery').addEventListener('change', () => composition?.setImagery(el<HTMLInputElement>('imagery').checked));
el('coverage').addEventListener('change', () => { if (map) { map.coverage = el<HTMLInputElement>('coverage').checked; map.invalidate(); } });
el('zoom-in').addEventListener('click', () => map?.zoomBy(1));
el('zoom-out').addEventListener('click', () => map?.zoomBy(-1));
el('fit').addEventListener('click', () => map?.fit());
async function refresh() {
  const button = el<HTMLButtonElement>('refresh'); button.disabled = true;
  try { update(await bridge.refresh()); if (!map) await start(); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  finally { if (!closed) button.disabled = false; }
}
el('refresh').addEventListener('click', () => { void refresh(); });
el('retry').addEventListener('click', () => {
  if (failed === 'discovery') { void refresh(); return; }
  if (!map) { void start(); return; }
  composition?.retry();
  el('status').textContent = 'Retrying missing map data…';
});
function shutdown() {
  if (closed) return;
  closed = true; generation++;
  composition?.dispose(); map?.destroy(); bridge.dispose();
  for (const id of ['zoom-in', 'zoom-out', 'fit', 'refresh', 'retry']) el<HTMLButtonElement>(id).disabled = true;
}
window.addEventListener('pagehide', shutdown, { once: true });
void start();
