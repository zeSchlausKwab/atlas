import { AtlasReader } from '../../packages/format/src/reader';
import { MAP_LAYERS, type MapLayer } from '../../packages/format/src/index';
import { HashtreeReader } from '../../packages/hashtree/src/reader';
import { verifyPublishedMap } from '../../packages/hashtree/src/published-map';
import type { CompositionMap, CompositionMapSource } from '../../packages/renderer/src/composition';
import type { ConsumerStatus, PreviewBridge } from './bridge';
export type CatalogEntry = ConsumerStatus['catalog'][number];
const identity = (entry: CatalogEntry) => `${entry.publisher}:${entry.offer.id}`;
const COLORS = ['#2a6588', '#b06c41', '#648747', '#875f9c'];
interface Session { entry: CatalogEntry; reader: AtlasReader; ready: boolean; opening: boolean; error?: string }
/** A source session is immutable by publisher/id/root. Display preferences never enable tools. */
export class MapComposition {
  catalog: CatalogEntry[] = [];
  layers: MapLayer[] = [...MAP_LAYERS];
  labels = { places: false, streets: false, pois: false };
  imagery = false;
  private selected: string[] = [];
  private userSelected = false;
  private discoverySettled = false;
  private appliedStyle = "";
  private fitted = false;
  private dead = false;
  private sessions = new Map<string, Session>();
  private timeoutMs = 30000;
  constructor(readonly map: CompositionMap, private bridge: PreviewBridge,
    private changed: () => void, private error: (message: string) => void,
    private read: () => void) {
    map.coverage = false;
    map.setLabels(false, false, false);
    map.setLayers(this.layers);
  }
  get active() { return this.selected.flatMap(id => this.catalog.filter(entry => identity(entry) === id)); }
  get opening() { return [...this.sessions.values()].some(s => s.opening); }
  get readyCount() { return [...this.sessions.values()].filter(s => s.ready).length; }
  get errors() { return [...this.sessions.values()].flatMap(s => s.error ? [s.error] : []); }
  get cacheHits() { return [...this.sessions.values()].reduce((sum, s) => sum + s.reader.cacheHits, 0); }
  isSelected(entry: CatalogEntry) { return this.selected.includes(identity(entry)); }
  state(entry: CatalogEntry) { const s = this.sessions.get(entry.key); return s?.error ? 'Could not load' : s?.ready ? 'Ready' : s?.opening ? 'Opening directory…' : 'Not selected'; }
  setCatalog(status: ConsumerStatus) {
    if (this.dead) return;
    this.timeoutMs = status.requestTimeoutMs;
    this.catalog = status.catalog.filter(e => !!e.offer.hashtree);
    this.discoverySettled = status.discovery.settled;
    if (!this.userSelected) {
      const preferred = status.preferredMapIds.flatMap(id => this.catalog.filter(e => e.offer.id === id));
      const recipe = status.defaultView?.sources.filter(s => s.enabled).flatMap(s => this.catalog.filter(e => e.offer.hashtree!.root === s.root)) ?? [];
      const vectors = this.catalog.filter(e => (e.offer.manifest.tileLayers ?? MAP_LAYERS).length > 0);
      const defaults = status.preferredMapIds.length ? preferred : status.defaultView ? recipe
        : this.discoverySettled ? (vectors.length ? vectors : this.catalog).slice(0, 1) : [];
      // Discovery is incremental. Keep collecting configured/default sources until
      // an explicit selection takes authority; never let the first offer win a race.
      this.selected = [...new Set(defaults.map(identity))];
    }
    if (status.defaultView) {
      // Signed paint is optional input only: never widen read purposes, enable
      // labels/imagery/tools, change geometry layers, or preload anything.
      const style = JSON.stringify(status.defaultView.presentation.style);
      if (style !== this.appliedStyle) { this.map.setStyle(status.defaultView.presentation.style); this.appliedStyle = style; }
    }
    this.reconcile();
  }
  select(entry: CatalogEntry, enabled: boolean) {
    this.userSelected = true;
    const id = identity(entry);
    this.selected = this.selected.filter(value => value !== id);
    if (enabled) this.selected.push(id);
    this.reconcile();
  }
  raise(entry: CatalogEntry) {
    this.userSelected = true;
    const id = identity(entry), index = this.selected.indexOf(id);
    if (index > 0) { [this.selected[index - 1], this.selected[index]] = [this.selected[index], this.selected[index - 1]]; this.sync(); this.changed(); }
  }
  setLayers(layers: MapLayer[]) { this.layers = layers; this.map.setLayers(layers); this.sync(); }
  setLabels(labels: typeof this.labels) {
    this.labels = labels;
    for (const s of this.sessions.values()) s.reader.options.purposes = this.purposes();
    this.map.setLabels(labels.streets, labels.pois, labels.places);
    this.sync();
  }
  setImagery(enabled: boolean) { this.imagery = enabled; this.sync(); }
  private purposes(): Array<'map' | 'labels'> { return Object.values(this.labels).some(Boolean) ? ['map', 'labels'] : ['map']; }
  private reconcile() {
    if (this.dead) return;
    const active = this.active, removed: Session[] = [];
    for (const [key, session] of this.sessions) {
      if (!active.some(e => e.key === key)) { this.sessions.delete(key); removed.push(session); }
    }
    // Detach renderer sessions before disposing their readers and in-flight reads.
    this.sync();
    for (const s of removed) s.reader.dispose();
    for (const entry of active) {
      const existing = this.sessions.get(entry.key);
      if (existing) {
        existing.entry = entry;
        if (existing.ready) {
          try { verifyPublishedMap(entry.offer, existing.reader); }
          catch (error) { existing.ready = false; existing.error = String(error); this.error(existing.error); }
        }
        continue;
      }
      const tree = entry.offer.hashtree!;
      const source = new HashtreeReader(`htree://${tree.root}`, tree, undefined, {
        memoryBytes: 16 * 1024 ** 2, requestTimeoutMs: this.timeoutMs + 1000,
        fetchBlob: (hash, signal) => this.bridge.blob(hash, tree.root, signal),
      });
      const session: Session = { entry, reader: new AtlasReader(source, () => { if (!this.dead && this.sessions.get(entry.key) === session) this.read(); }, { purposes: this.purposes() }), ready: false, opening: false };
      this.sessions.set(entry.key, session);
      void this.open(session);
    }
    this.sync(); this.fitIfReady(); this.changed();
  }
  private async open(session: Session) {
    if (this.dead || session.opening) return;
    session.opening = true; session.error = undefined;
    try {
      await session.reader.open();
      if (this.dead || this.sessions.get(session.entry.key) !== session) return;
      verifyPublishedMap(session.entry.offer, session.reader);
      session.ready = true;
      this.sync();
      this.fitIfReady();
    } catch (error) {
      if (!this.dead && this.sessions.get(session.entry.key) === session) {
        session.error = `${session.entry.offer.manifest.name}: ${error instanceof Error ? error.message : String(error)}`;
        this.error(session.error);
      }
    } finally {
      session.opening = false;
      if (!this.dead && this.sessions.get(session.entry.key) === session) this.changed();
    }
  }
  private fitIfReady() {
    if (!this.fitted && (this.discoverySettled || this.userSelected) && this.active.length && this.active.every(e => this.sessions.get(e.key)?.ready)) {
      this.map.fit(); this.fitted = true;
    }
  }
  private sync() {
    if (this.dead) return;
    const sources: CompositionMapSource[] = this.active.flatMap((entry, index) => {
      const session = this.sessions.get(entry.key);
      if (!session?.ready) return [];
      return [{ id: entry.key, reader: session.reader, manifest: session.reader.index.manifest,
        enabled: true, layers: [...this.layers], labels: Object.values(this.labels).some(Boolean),
        color: COLORS[index % COLORS.length], rasterOpacity: this.imagery ? 0.7 : 0 }];
    });
    this.map.setSources(sources);
  }
  retry() {
    if (this.dead) return;
    for (const session of this.sessions.values()) if (!session.ready && !session.opening) void this.open(session);
    // Existing renderer retry path retains camera, decoded blocks, meshes and labels.
    this.map.setOffline(false);
    this.changed();
  }
  dispose() {
    if (this.dead) return;
    this.map.setSources([]);
    this.dead = true;
    for (const session of this.sessions.values()) session.reader.dispose();
    this.sessions.clear();
  }
}
