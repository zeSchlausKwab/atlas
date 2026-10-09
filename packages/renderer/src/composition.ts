import type { WorkspaceMap } from "./workspace-map";
import { defaultOverlays, type OverlayFrame } from "./overlays";
import { FeatureOverlay } from "./features";
import type { AtlasMap, MapStats } from "./map";
import type { MapFeature, Bounds } from "../../features/src/index";
import type { Location } from "../../geocoding/src/model";
import type {
  Position,
  WalkingResult,
  Reachable,
} from "../../routing/src/index";
import { MAP_LAYERS, LAYER_MASKS, type Peak } from "../../format/src/index";
import { FLAT_SCENE, parseScene, type MapScene } from "./style";
import init, { Renderer } from "../pkg/atlas_renderer";
import { TileScheduler } from "./tile-scheduler";
import { MapInput } from "./input";
import { MapLabels } from "./labels";
import { PAPER, compileStyle, type MapStyle } from "./style";
import {
  cameraBounds,
  fitZoom,
  groundDelta,
  screenToWorld,
  worldProjector,
  type Camera,
} from "./camera";
import {
  clipArrays,
  contains,
  coverageBounds,
  coverageOf,
  CoveredTiles,
  planComposition,
  polygonsOf,
  type Channel,
  type CompositionSource,
} from "./composition-plan";
import {
  project,
  unproject,
  tileLayer,
  type Place,
  type MapLayer,
} from "../../format/src/index";
import { AtlasReader } from "../../format/src/reader";
import { decodePlaces, PLACE_LABEL_KEY } from "../../labels/src/places";
export interface CompositionMapSource extends CompositionSource {
  reader: AtlasReader;
  color: string;
}
interface Session {
  source: CompositionMapSource;
  tiles: CoveredTiles;
  scheduler: TileScheduler;
  labels: MapLabels;
  shown: string[];
  prefix: string;
  clips: Map<Channel, number>;
  places?: Place[];
  placesLoading: boolean;
  placesFailed: boolean;
  dead: boolean;
}
export interface CompositionStats extends MapStats {
  zoom: number;
  tiles: number;
  missing: number;
  loading: number;
  sources: number;
  triangles: number;
  bytes: number;
}
/** One WASM/WebGL renderer and camera. Sessions own immutable source identities;
 * the composition owns display precedence, never semantic graph compatibility. */
export class CompositionMap implements WorkspaceMap {
  reader!: AtlasReader; // Explicitly selected source for scoped tools.
  readonly overlays = defaultOverlays();
  private debugOverlays = defaultOverlays();
  private featureOverlay = new FeatureOverlay();
  private scene: MapScene = { ...FLAT_SCENE };
  private state: OverlayFrame["state"] = {
    routingCells: [],
    reachable: null,
    selection: null,
    grid: false,
    cache: false,
    route: null,
    endpoints: [null, null],
    location: null,
    selected: null,
  };
  private storedKeys = new Map<string, ReadonlySet<string>>();
  private picker: {
    owner: string;
    choose: (p: Position) => void;
    cancel: () => void;
    finish?: () => void;
  } | null = null;
  private globalLayers: readonly MapLayer[] = MAP_LAYERS;
  private placeNames = true;
  private streetNames = true;
  private pois = true;
  onFeatureSelect?: (id: string) => void;
  onPoiSelect?: (poi: Location) => void;
  onPickModeChange?: (hint: string | null) => void;
  onSceneChange?: (scene: MapScene) => void;
  setFeatures(features: MapFeature[], selected: Set<string>) {
    this.featureOverlay.features = features;
    this.featureOverlay.selected = new Set(selected);
    this.invalidate();
  }
  setReachable(value: Reachable | null) {
    this.state.reachable = value;
    this.invalidate();
  }
  setRoutingCells(cells: Array<{ key: string; state: string }>) {
    this.state.routingCells = cells;
    this.invalidate();
  }
  setSelection(points: Position[], closed = true) {
    this.state.selection = { points, closed };
    this.invalidate();
  }
  setEndpoints(start: Position | null, end: Position | null) {
    this.state.endpoints = [start, end];
    this.state.route = null;
    this.invalidate();
  }
  setRoute(route: Extract<WalkingResult, { status: "found" }> | null) {
    this.state.route = route;
    this.invalidate();
  }
  fitRoute() {
    if (this.state.route)
      this.fitPositions([
        ...this.state.route.coordinates,
        ...this.state.endpoints.filter((p): p is Position => !!p),
      ]);
  }
  fitPositions(positions: Position[]) {
    if (!positions.length) return;
    let w = Infinity,
      n = Infinity,
      e = -Infinity,
      s = -Infinity;
    for (const point of positions) {
      const [x, y] = project(...point);
      w = Math.min(w, x);
      n = Math.min(n, y);
      e = Math.max(e, x);
      s = Math.max(s, y);
    }
    this.center = [(w + e) / 2, (n + s) / 2];
    this.zoom = Math.max(
      0,
      Math.min(
        20,
        fitZoom(
          [w, n, e, s],
          Math.max(160, this.canvas.clientWidth - 140),
          Math.max(160, this.canvas.clientHeight - 220),
          this.pitch,
          this.bearing,
        ),
      ),
    );
    this.invalidate();
  }
  beginPicking(
    owner: string,
    choose: (p: Position) => void,
    cancel: () => void,
    hint: string,
    finish?: () => void,
  ) {
    if (this.picker && this.picker.owner !== owner) {
      const previous = this.picker;
      this.picker = null;
      previous.cancel();
    }
    this.picker = { owner, choose, cancel, finish };
    this.canvas.classList.add("picking");
    this.onPickModeChange?.(hint);
  }
  endPicking(owner: string) {
    if (this.picker?.owner !== owner) return;
    this.picker = null;
    this.canvas.classList.remove("picking");
    this.onPickModeChange?.(null);
  }
  focusLocation(
    coordinates: Position,
    name: string,
    zoom = 17,
    street?: Position[],
    requested?: Position,
  ) {
    this.state.location = { coordinates, name, street, requested };
    this.state.selected = null;
    this.center = project(...coordinates);
    this.zoom = Math.max(0, Math.min(20, zoom));
    this.invalidate();
  }
  clearLocation() {
    this.state.location = null;
    this.invalidate();
  }
  focus(peak: Peak) {
    this.state.location = null;
    this.state.selected = peak;
    this.center = project(...peak.coordinates);
    this.zoom = Math.max(this.zoom, 13);
    this.invalidate();
  }
  viewBounds(): Bounds {
    const [w, n, e, s] = cameraBounds(this.camera),
      sw = unproject(w, s),
      ne = unproject(e, n);
    return [
      Math.max(-180, sw[0]),
      Math.max(-85, sw[1]),
      Math.min(180, ne[0]),
      Math.min(85, ne[1]),
    ];
  }
  setScene(scene: MapScene) {
    // Stencil ownership is on the ground plane; 3D remains available in single-map mode.
    this.scene = { ...parseScene(scene), extrude: false };
    this.pitch = this.scene.pitch;
    this.bearing = this.scene.bearing;
    this.onSceneChange?.({ ...this.scene });
    this.invalidate();
  }
  resetView() {
    this.setScene({ ...this.scene, pitch: 0, bearing: 0 });
  }
  setLayers(layers: number | readonly MapLayer[]) {
    this.globalLayers =
      typeof layers === "number"
        ? MAP_LAYERS.filter((l) => (LAYER_MASKS[l] & layers) !== 0)
        : layers;
    this.revision++;
    this.invalidate();
  }
  setLabels(roads: boolean, pois: boolean, places = true) {
    this.streetNames = roads;
    this.pois = pois;
    this.placeNames = places;
    for (const s of this.sessions.values()) {
      s.labels.roads = roads;
      s.labels.pois = pois;
    }
    this.revision++;
    this.invalidate();
  }
  setOffline(offline: boolean) {
    for (const s of this.sessions.values()) {
      s.source.reader.offline = offline;
      s.scheduler.retry();
      s.labels.retry();
      s.placesFailed = false;
    }
    this.invalidate();
  }
  setGrid(enabled: boolean) {
    this.state.grid = enabled;
    this.invalidate();
  }
  setCacheView(enabled: boolean, _keys?: ReadonlySet<string>) {
    this.state.cache = enabled;
    this.invalidate();
  }
  async refreshCacheView(enabled: boolean) {
    this.setCacheView(enabled);
    if (!enabled) return;
    await Promise.all(
      [...this.sessions.values()].map(async (s) => {
        const snapshot = s.source.manifest.snapshot;
        const keys = await s.source.reader.options.store?.keys(snapshot);
        if (!s.dead) this.storedKeys.set(snapshot, new Set(keys));
      }),
    );
    this.invalidate();
  }
  get memory(): AtlasMap["memory"] {
    type Stats = AtlasMap["memory"]["labels"];
    const sum = (items: Stats[]): Stats =>
      items.reduce(
        (a, b) => ({
          bytes: a.bytes + b.bytes,
          budget: a.budget + b.budget,
          entries: a.entries + b.entries,
          evictions: a.evictions + b.evictions,
          overage: a.overage + b.overage,
        }),
        { bytes: 0, budget: 0, entries: 0, evictions: 0, overage: 0 },
      );
    const sessions = [...this.sessions.values()],
      readers = sessions.map((s) => s.source.reader.memory);
    const decoded = Object.fromEntries(
      Object.keys(this.reader.memory.decoded).map((k) => [
        k,
        sum(readers.map((r) => r.decoded[k as keyof typeof r.decoded])),
      ]),
    ) as AtlasMap["memory"]["reader"]["decoded"];
    return {
      reader: { decoded, directory: sum(readers.map((r) => r.directory)) },
      meshes: {
        ...sum(sessions.map((s) => s.scheduler.memory)),
        uploads: sessions.reduce((n, s) => n + s.scheduler.memory.uploads, 0),
        prepareMs: sessions.reduce(
          (n, s) => n + s.scheduler.memory.prepareMs,
          0,
        ),
      },
      labels: sum(sessions.map((s) => s.labels.memory)),
    };
  }
  private renderer!: Renderer;
  private sessions = new Map<string, Session>();
  private sources: CompositionMapSource[] = [];
  private input: MapInput;
  private observer: ResizeObserver;
  private frame = 0;
  private serial = 0;
  private revision = 0;
  private planned = "";
  private planRevision = 0;
  private dead = false;
  private style = PAPER;
  private overlay: HTMLCanvasElement;
  center: [number, number] = [0.5, 0.5];
  zoom = 4;
  pitch = 0;
  bearing = 0;
  coverage = true;
  constructor(
    readonly canvas: HTMLCanvasElement,
    private onStats: (stats: CompositionStats) => void,
    private onError: (id: string, error: string) => void,
  ) {
    this.overlays.remove("labels");
    this.overlays.remove("tile-grid");
    this.overlays.remove("cache-coverage");
    for (const id of [
      "labels",
      "routing-cells",
      "reachability",
      "selection",
      "route",
      "location",
      "peak",
      "scale",
    ])
      this.debugOverlays.remove(id);
    this.overlay = document.createElement("canvas");
    this.overlay.className = "composition-overlay";
    canvas.after(this.overlay);
    this.input = new MapInput(canvas, {
      pan: (x, y) => {
        const d = groundDelta(x, y, this.pitch, this.bearing),
          w = 256 * 2 ** this.zoom;
        this.center = [this.center[0] - d[0] / w, this.center[1] - d[1] / w];
        this.invalidate();
      },
      orbit: (x, y) => {
        this.bearing = (this.bearing + x * 0.35) % 360;
        this.pitch = Math.max(0, Math.min(60, this.pitch - y * 0.25));
        this.setScene({
          ...this.scene,
          pitch: this.pitch,
          bearing: this.bearing,
        });
      },
      zoom: (delta, x, y) => this.zoomBy(delta, x, y),
      click: (x, y) => {
        if (this.picker) {
          this.picker.choose(unproject(...screenToWorld([x, y], this.camera)));
          return;
        }
        const feature = this.featureOverlay.pick(
          this.overlay.getContext("2d")!,
          x,
          y,
        );
        if (feature) {
          this.onFeatureSelect?.(feature);
          return;
        }
        if (!this.pois) return;
        const world = screenToWorld([x, y], this.camera);
        for (const s of this.sessions.values()) {
          const mask = s.tiles.parts.get("labels");
          if (!mask || !contains(mask, world)) continue;
          const poi = s.labels.pick(x, y);
          if (poi) {
            this.onPoiSelect?.(poi);
            break;
          }
        }
      },
      command: (command) => {
        if (command === "reset") {
          this.resetView();
          return;
        }
        const picker = this.picker;
        if (!picker) return;
        if (command === "cancel") {
          this.endPicking(picker.owner);
          picker.cancel();
        } else if (command === "finish" && picker.finish) picker.finish();
        else picker.choose(unproject(...this.center));
      },
    });
    this.observer = new ResizeObserver(() => this.invalidate());
    this.observer.observe(canvas);
  }
  static async create(
    canvas: HTMLCanvasElement,
    stats: (s: CompositionStats) => void,
    error: (id: string, e: string) => void,
  ) {
    await init({ module_or_path: "/wasm/atlas_renderer_bg.wasm" });
    const map = new CompositionMap(canvas, stats, error);
    map.renderer = new Renderer(canvas);
    map.setStyle(PAPER);
    return map;
  }
  get camera(): Camera {
    return {
      center: this.center,
      zoom: this.zoom,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      pitch: this.pitch,
      bearing: this.bearing,
    };
  }
  setStyle(style: MapStyle) {
    const p = compileStyle(style);
    this.style = p.style;
    this.renderer.set_style(p.background, p.colors, p.widths);
    this.invalidate();
  }
  reset() {
    this.resetView();
  }
  zoomBy(delta: number, x = 0, y = 0) {
    const before = 2 ** this.zoom;
    this.zoom = Math.max(0, Math.min(20, this.zoom + delta));
    const d = groundDelta(x, y, this.pitch, this.bearing),
      change = 1 / (256 * before) - 1 / (256 * 2 ** this.zoom);
    this.center = [
      this.center[0] + d[0] * change,
      this.center[1] + d[1] * change,
    ];
    this.invalidate();
  }
  fit(ids?: string[]) {
    const sources = this.sources.filter(
      (s) => s.enabled && (!ids || ids.includes(s.id)),
    );
    if (!sources.length) return;
    const boxes = sources.map((s) => coverageBounds(coverageOf(s.manifest)));
    const b: [number, number, number, number] = [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ];
    this.center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    this.zoom = Math.max(
      0,
      Math.min(
        19,
        fitZoom(
          b,
          this.canvas.clientWidth - 100,
          this.canvas.clientHeight - 100,
          this.pitch,
          this.bearing,
        ),
      ),
    );
    this.invalidate();
  }
  setSources(sources: CompositionMapSource[]) {
    this.sources = sources.filter((s) => s.enabled);
    for (const [id, session] of this.sessions)
      if (!this.sources.some((s) => s.id === id)) {
        session.dead = true;
        session.scheduler.destroy();
        session.labels.destroy();
        this.sessions.delete(id);
      }
    for (const source of this.sources) {
      const existing = this.sessions.get(source.id);
      if (existing) {
        existing.source = source;
        continue;
      }
      const prefix = `${++this.serial}|`,
        tiles = new CoveredTiles(source.reader);
      const session = {} as Session;
      Object.assign(session, {
        source,
        tiles,
        prefix,
        shown: [],
        clips: new Map(),
        placesLoading: false,
        placesFailed: false,
        dead: false,
      });
      session.labels = new MapLabels(
        source.reader,
        () => this.invalidate(),
        (e) => this.onError(source.id, e),
        2 * 1024 * 1024,
      );
      session.labels.roads = this.streetNames;
      session.labels.pois = this.pois;
      session.scheduler = new TileScheduler(
        tiles,
        {
          upload: (b, bytes) => {
            const k = prefix + b.key;
            this.renderer.add_tile_part(k, b.z!, b.x!, b.y!, bytes);
            return this.renderer.tile_bytes(k);
          },
          remove: (k) => this.renderer.remove_tile(prefix + k),
          show: (keys) => {
            session.shown = keys;
          },
        },
        () => this.invalidate(),
        (e) => this.onError(source.id, e),
        12 * 1024 * 1024,
      );
      this.sessions.set(source.id, session);
    }
    this.revision++;
    this.planned = "";
    this.invalidate();
  }
  private plan() {
    const key = `${this.revision}/${Math.floor(this.zoom)}`;
    if (key === this.planned) return;
    this.planned = key;
    this.planRevision++;
    this.renderer.clear_clips();
    for (const s of this.sessions.values()) {
      s.tiles.parts.clear();
      s.clips.clear();
    }
    let id = 0;
    for (const part of planComposition(
      this.sources.map((s) => ({
        ...s,
        layers: s.layers.filter((l) => this.globalLayers.includes(l)),
        labels: s.labels && (this.placeNames || this.streetNames || this.pois),
      })),
      Math.floor(this.zoom),
    )) {
      const s = this.sessions.get(part.source)!;
      s.tiles.parts.set(part.channel, part.coverage);
      if (part.channel !== "labels") {
        const a = clipArrays(part.coverage);
        this.renderer.set_clip(++id, a.coordinates, a.rings, a.polygons);
        s.clips.set(part.channel, id);
      }
    }
  }
  invalidate() {
    if (!this.dead && !this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.renderer) this.draw();
      });
  }
  private draw() {
    this.plan();
    const camera = this.camera,
      { width, height } = camera,
      ratio = Math.min(devicePixelRatio, 2);
    for (const c of [this.canvas, this.overlay])
      if (
        c.width !== Math.round(width * ratio) ||
        c.height !== Math.round(height * ratio)
      ) {
        c.width = Math.round(width * ratio);
        c.height = Math.round(height * ratio);
      }
    const ctx = this.overlay.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const view = cameraBounds(camera),
      visible: string[] = [],
      stats: CompositionStats = {
        zoom: this.zoom,
        tiles: 0,
        wanted: 0,
        fallbackTiles: 0,
        drawMs: 0,
        labels: { roads: 0, pois: 0, loading: 0, missing: 0, places: 0 },
        missing: 0,
        loading: 0,
        sources: 0,
        triangles: 0,
        bytes: 0,
      };
    const frames: OverlayFrame[] = [];
    for (const s of this.sessions.values()) {
      const b = coverageBounds(coverageOf(s.source.manifest));
      const w = Math.max(view[0], b[0]),
        north = Math.max(view[1], b[1]),
        e = Math.min(view[2], b[2]),
        south = Math.min(view[3], b[3]);
      const active =
        w < e && north < south && this.zoom >= s.source.manifest.minZoom;
      const z = Math.max(
          s.source.manifest.minZoom,
          Math.min(s.source.manifest.maxZoom, Math.floor(this.zoom)),
        ),
        n = 2 ** z;
      const layers = active ? ([...s.clips.keys()] as MapLayer[]) : [];
      const result = s.scheduler.update({
        revision: this.planRevision,
        range: [
          z,
          Math.max(0, Math.floor(w * n)),
          Math.min(n - 1, Math.floor(e * n)),
          Math.max(0, Math.floor(north * n)),
          Math.min(n - 1, Math.floor(south * n)),
        ],
        layers,
        bounds: view,
      });
      for (const k of s.shown) {
        const clip = s.clips.get(tileLayer(k)!);
        if (clip !== undefined) {
          this.renderer.set_tile_clip(s.prefix + k, clip);
          visible.push(s.prefix + k);
        }
      }
      frames.push({
        ctx,
        camera,
        style: this.style,
        view: result.view,
        resident: (k) => s.scheduler.has(k),
        cached: (k) =>
          !!this.storedKeys.get(s.source.manifest.snapshot)?.has(k) ||
          s.source.reader.cache.has(k) ||
          s.scheduler.has(k),
        labels: s.labels,
        features: this.featureOverlay,
        places: [],
        placesLoading: false,
        placesMissing: false,
        state: this.state,
        labelStats: { roads: 0, pois: 0, loading: 0, missing: 0 },
      });
      stats.wanted += result.wanted;
      stats.fallbackTiles += result.presented.filter(
        (b) => b.z !== result.view.zoom,
      ).length;
      stats.tiles += result.tiles;
      stats.missing += result.missing;
      stats.loading += result.loading;
      stats.bytes += s.source.reader.bytesRead;
      if (active && (layers.length || s.tiles.parts.has("labels")))
        stats.sources++;
    }
    this.renderer.set_visible(visible.join(","));
    // Ground-plane composition: coverage masks have one unambiguous boundary.
    const drawStart = performance.now();
    stats.triangles = this.renderer.render(
      ...this.center,
      this.zoom,
      width,
      height,
      ratio,
      this.pitch,
      this.bearing,
      0,
      12,
      0,
    );
    stats.drawMs = performance.now() - drawStart;
    for (const f of frames) this.debugOverlays.draw(f);
    this.featureOverlay.draw(ctx, camera);
    const occupied: [number, number, number, number][] = [],
      toScreen = worldProjector(camera);
    for (const source of this.sources) {
      const s = this.sessions.get(source.id)!;
      const mask = s.tiles.parts.get("labels");
      const b = mask && coverageBounds(mask);
      if (
        mask &&
        b &&
        b[0] < view[2] &&
        b[2] > view[0] &&
        b[1] < view[3] &&
        b[3] > view[1]
      ) {
        const accepts = (box: [number, number, number, number]) =>
          [
            [box[0], box[1]],
            [box[2], box[1]],
            [box[2], box[3]],
            [box[0], box[3]],
          ].every((p) =>
            contains(mask, screenToWorld(p as [number, number], camera)),
          );
        if (
          this.placeNames &&
          !s.places &&
          !s.placesLoading &&
          !s.placesFailed
        ) {
          if (
            source.reader.index.blocks.some((b) => b.key === PLACE_LABEL_KEY)
          ) {
            s.placesLoading = true;
            source.reader
              .block(PLACE_LABEL_KEY)
              .then((bytes) => {
                if (!s.dead) s.places = decodePlaces(bytes);
              })
              .catch((e) => {
                if (!s.dead) {
                  s.placesFailed = true;
                  this.onError(source.id, String(e));
                }
              })
              .finally(() => {
                s.placesLoading = false;
                this.invalidate();
              });
          } else s.places = source.manifest.places;
        }
        ctx.font = '500 12px "Avenir Next", sans-serif';
        ctx.textAlign = "center";
        for (const place of this.placeNames ? (s.places ?? []) : []) {
          const [x, y] = toScreen(project(...place.coordinates)),
            half = ctx.measureText(place.name).width / 2 + 4;
          const box: [number, number, number, number] = [
            x - half,
            y - 13,
            x + half,
            y + 5,
          ];
          if (
            x < 20 ||
            y < 20 ||
            x > width - 20 ||
            y > height - 20 ||
            !accepts(box) ||
            occupied.some(
              (b) =>
                b[0] < box[2] &&
                b[2] > box[0] &&
                b[1] < box[3] &&
                b[3] > box[1],
            )
          )
            continue;
          ctx.lineWidth = 3;
          ctx.strokeStyle = this.style.labels.halo;
          ctx.fillStyle = this.style.labels.color;
          ctx.strokeText(place.name, x, y);
          ctx.fillText(place.name, x, y);
          occupied.push(box);
          stats.labels.places!++;
        }
        const labels = s.labels.draw(
          ctx,
          camera,
          this.style.labels,
          occupied,
          accepts,
        );
        stats.labels.roads += labels.roads;
        stats.labels.pois += labels.pois;
        stats.labels.loading += labels.loading;
        stats.labels.missing += labels.missing;
        stats.loading += labels.loading + (s.placesLoading ? 1 : 0);
        stats.missing += labels.missing;
      }
      if (this.coverage) {
        ctx.strokeStyle = source.color;
        ctx.fillStyle = source.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        const poly = coverageOf(source.manifest);
        for (const rings of polygonsOf(poly))
          for (const ring of rings) {
            ctx.beginPath();
            ring.forEach((p, i) => {
              const [x, y] = toScreen(p as [number, number]);
              i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.closePath();
            ctx.stroke();
          }
        ctx.setLineDash([]);
      }
    }
    if (frames[0]) this.overlays.draw(frames[0]);
    this.onStats(stats);
  }
  destroy() {
    if (this.dead) return;
    if (this.picker) this.endPicking(this.picker.owner);
    this.overlays.destroy();
    this.debugOverlays.destroy();
    this.dead = true;
    cancelAnimationFrame(this.frame);
    this.input.destroy();
    this.observer.disconnect();
    for (const s of this.sessions.values()) {
      s.dead = true;
      s.scheduler.destroy();
      s.labels.destroy();
    }
    this.renderer.free();
    this.overlay.remove();
  }
}
