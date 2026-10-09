import { defaultOverlays } from "./overlays";
import { MapInput } from "./input";
import type { Reachable } from "../../routing/src/index";
import { TileScheduler } from "./tile-scheduler";
import { PLACE_LABEL_KEY, decodePlaces } from "../../labels/src/places";
import type { Place } from "../../format/src/index";
import {
  PAPER,
  FLAT_SCENE,
  compileStyle,
  parseScene,
  type MapStyle,
  type MapScene,
} from "./style";
import {
  cameraBounds,
  fitZoom,
  groundDelta,
  metersPerPixel,
  screenToWorld,
  type Camera,
} from "./camera";
import { FeatureOverlay } from "./features";
import type { MapFeature, Bounds } from "../../features/src/index";
import { MapLabels, type LabelStats } from "./labels";
import type { Location } from "../../geocoding/src/model";
import init, { Renderer } from "../pkg/atlas_renderer";
import { AtlasReader } from "../../format/src/reader";
import {
  MAP_LAYERS,
  LAYER_MASKS,
  project,
  unproject,
  type Peak,
  type MapLayer,
} from "../../format/src/index";
import type { Position, WalkingResult } from "../../routing/src/index";
export const MAX_VIEW_ZOOM = 20;
export interface MapOptions {
  style?: MapStyle;
  scene?: MapScene;
  layers?: readonly MapLayer[];
  placeNames?: boolean;
  streetNames?: boolean;
  pois?: boolean;
  cacheBudgets?: { meshes?: number; labels?: number };
}
export interface MapStats {
  zoom: number;
  tiles: number;
  wanted: number;
  missing: number;
  triangles: number;
  fallbackTiles: number;
  drawMs: number;
  loading: number;
  labels: LabelStats;
}
export class AtlasMap {
  renderer!: Renderer;
  readonly overlays = defaultOverlays();
  private featureOverlay = new FeatureOverlay();
  onFeatureSelect?: (id: string) => void;
  setFeatures(features: MapFeature[], selected: Set<string>) {
    this.featureOverlay.features = features;
    this.featureOverlay.selected = new Set(selected);
    this.invalidate();
  }
  private style = compileStyle(PAPER).style;
  private scene: MapScene = { ...FLAT_SCENE };
  get camera(): Camera {
    return {
      center: this.center,
      zoom: this.zoom,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      pitch: this.scene.pitch,
      bearing: this.scene.bearing,
    };
  }
  setStyle(style: MapStyle) {
    const compiled = compileStyle(style);
    this.renderer.set_style(
      compiled.background,
      compiled.colors,
      compiled.widths,
    );
    this.style = compiled.style;
    this.invalidate();
  }
  onSceneChange?: (scene: MapScene) => void;
  setScene(scene: MapScene) {
    this.scene = parseScene(scene);
    this.onSceneChange?.({ ...this.scene });
    this.invalidate();
  }
  viewBounds(): Bounds {
    const [w, n, e, south] = cameraBounds(this.camera);
    const sw = unproject(w, south),
      ne = unproject(e, n);
    return [
      Math.max(-180, sw[0]),
      Math.max(-85, sw[1]),
      Math.min(180, ne[0]),
      Math.min(85, ne[1]),
    ];
  }
  center: [number, number] = [0.5, 0.5];
  zoom = 10;
  private reachable: Reachable | null = null;
  setReachable(value: Reachable | null) {
    this.reachable = value;
    this.invalidate();
  }
  private routingCells: Array<{ key: string; state: string }> = [];
  setRoutingCells(cells: Array<{ key: string; state: string }>) {
    this.routingCells = cells;
    this.invalidate();
  }
  grid = false;
  private cacheView = false;
  private storedKeys: ReadonlySet<string> = new Set();
  setCacheView(
    enabled: boolean,
    storedKeys: ReadonlySet<string> = this.storedKeys,
  ) {
    this.cacheView = enabled;
    this.storedKeys = storedKeys;
    this.invalidate();
  }
  selected: Peak | null = null;
  onPoiSelect?: (poi: Location) => void;
  private placeNames = true;
  private places: Place[] | undefined;
  private placesLoading = false;
  private placesFailed = false;
  private labels: MapLabels;
  private labelStats: LabelStats = {
    roads: 0,
    pois: 0,
    loading: 0,
    missing: 0,
  };
  setLabels(roads: boolean, pois: boolean, places = this.placeNames) {
    this.placeNames = places;
    this.labels.roads = roads;
    this.labels.pois = pois;
    this.invalidate();
  }
  onPickModeChange?: (hint: string | null) => void;
  private selection: { points: Position[]; closed: boolean } | null = null;
  setSelection(points: Position[], closed = true) {
    this.selection = { points, closed };
    this.invalidate();
  }
  private picker: {
    owner: string;
    choose: (position: Position) => void;
    cancel: () => void;
    finish?: () => void;
  } | null = null;
  private location: {
    coordinates: Position;
    name: string;
    street?: Position[];
    requested?: Position;
  } | null = null;
  private endpoints: [Position | null, Position | null] = [null, null];
  private route: Extract<WalkingResult, { status: "found" }> | null = null;
  private layerMask = 255;
  private tiles!: TileScheduler;
  private dead = false;
  private frame = 0;
  private input!: MapInput;
  private observer: ResizeObserver;
  private lastDraw = 0;
  private triangles = 0;
  private overlay: HTMLCanvasElement;
  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly reader: AtlasReader,
    readonly onStats: (stats: MapStats) => void,
    readonly onError: (message: string) => void,
    options: MapOptions,
  ) {
    this.labels = new MapLabels(
      reader,
      () => this.invalidate(),
      onError,
      options.cacheBudgets?.labels,
    );
    this.overlay = document.createElement("canvas");
    this.overlay.className = "map-overlay";
    canvas.after(this.overlay);
    this.observer = new ResizeObserver(() => this.invalidate());
    this.observer.observe(canvas);
  }
  static async create(
    canvas: HTMLCanvasElement,
    reader: AtlasReader,
    onStats: (stats: MapStats) => void,
    onError: (message: string) => void,
    options: MapOptions = {},
  ) {
    await init({ module_or_path: "/wasm/atlas_renderer_bg.wasm" });
    const map = new AtlasMap(canvas, reader, onStats, onError, options);
    map.renderer = new Renderer(canvas);
    map.tiles = new TileScheduler(
      reader,
      {
        upload: (b, bytes) => {
          map.renderer.add_tile_part(b.key, b.z!, b.x!, b.y!, bytes);
          return map.renderer.tile_bytes(b.key);
        },
        remove: (key) => map.renderer.remove_tile(key),
        show: (keys) => map.renderer.set_visible(keys.join(",")),
      },
      () => map.invalidate(),
      onError,
      options.cacheBudgets?.meshes,
    );
    map.setStyle(options.style ?? PAPER);
    map.setScene(options.scene ?? FLAT_SCENE);
    map.setLayers(options.layers ?? 255);
    map.setLabels(
      options.streetNames ?? true,
      options.pois ?? true,
      options.placeNames ?? true,
    );
    map.events();
    map.fit();
    return map;
  }
  private events() {
    this.input = new MapInput(this.canvas, {
      pan: (x, y) => {
        const [dx, dy] = groundDelta(
          x,
          y,
          this.scene.pitch,
          this.scene.bearing,
        );
        const scale = 256 * 2 ** this.zoom;
        this.center = [
          this.center[0] - dx / scale,
          this.center[1] - dy / scale,
        ];
        this.invalidate();
      },
      orbit: (x, y) => this.orbit(x, y),
      zoom: (delta, x, y) => this.zoomAt(this.zoom + delta, x, y),
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
        const poi = this.labels.pick(x, y);
        if (poi) this.onPoiSelect?.(poi);
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
  }
  private orbit(dx: number, dy: number) {
    const pitch = Math.max(0, Math.min(65, this.scene.pitch - dy * 0.35));
    const bearing =
      ((((this.scene.bearing + dx * 0.3 + 540) % 360) + 360) % 360) - 180;
    this.setScene({
      ...this.scene,
      pitch,
      bearing,
      extrude: this.scene.extrude || pitch > 0,
    });
  }
  resetView() {
    this.setScene({ ...this.scene, pitch: 0, bearing: 0, extrude: false });
  }
  fit() {
    const [w, s, e, n] = this.reader.index.manifest.bounds;
    const a = project(w, n);
    const b = project(e, s);
    this.center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    this.zoom = Math.max(
      this.reader.index.manifest.minZoom,
      Math.min(
        this.reader.index.manifest.maxZoom,
        fitZoom(
          [a[0], a[1], b[0], b[1]],
          this.canvas.clientWidth - 90,
          this.canvas.clientHeight - 100,
          this.scene.pitch,
          this.scene.bearing,
        ),
      ),
    );
    this.selected = null;
    this.invalidate();
  }
  beginPicking(
    owner: string,
    choose: (position: Position) => void,
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
    this.location = { coordinates, name, street, requested };
    this.selected = null;
    this.center = project(...coordinates);
    this.zoom = Math.max(
      Math.max(0, this.reader.index.manifest.minZoom - 1),
      Math.min(MAX_VIEW_ZOOM, zoom),
    );
    this.invalidate();
  }
  clearLocation() {
    this.location = null;
    this.invalidate();
  }
  setEndpoints(start: Position | null, end: Position | null) {
    this.endpoints = [start, end];
    this.route = null;
    this.invalidate();
  }
  setRoute(route: Extract<WalkingResult, { status: "found" }> | null) {
    this.route = route;
    this.invalidate();
  }
  fitRoute() {
    if (!this.route) return;
    this.fitPositions([
      ...this.route.coordinates,
      ...this.endpoints.filter((p): p is Position => p !== null),
    ]);
  }
  fitPositions(positions: Position[]) {
    if (!positions.length) return;
    const points = positions.map((p) => project(...p));
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    this.center = [(minX + maxX) / 2, (minY + maxY) / 2];
    this.zoom = Math.max(
      this.reader.index.manifest.minZoom,
      Math.min(
        this.reader.index.manifest.maxZoom + 1,
        fitZoom(
          [minX, minY, maxX, maxY],
          this.canvas.clientWidth - 140,
          this.canvas.clientHeight - 340,
          this.scene.pitch,
          this.scene.bearing,
        ),
      ),
    );
    this.selected = null;
    this.invalidate();
  }
  zoomBy(delta: number) {
    this.zoomAt(this.zoom + delta, 0, 0);
  }
  private zoomAt(zoom: number, x: number, y: number) {
    zoom = Math.max(
      Math.max(0, this.reader.index.manifest.minZoom - 1),
      Math.min(MAX_VIEW_ZOOM, zoom),
    );
    [x, y] = groundDelta(x, y, this.scene.pitch, this.scene.bearing);
    const before = 256 * 2 ** this.zoom;
    const after = 256 * 2 ** zoom;
    this.center = [
      this.center[0] + x / before - x / after,
      this.center[1] + y / before - y / after,
    ];
    this.zoom = zoom;
    this.invalidate();
  }
  focus(peak: Peak) {
    this.location = null;
    this.selected = peak;
    this.center = project(...peak.coordinates);
    this.zoom = Math.max(this.zoom, 13);
    this.invalidate();
  }
  setLayers(layers: number | readonly MapLayer[]) {
    const mask =
      typeof layers === "number"
        ? layers
        : layers.reduce((mask, l) => mask | LAYER_MASKS[l], 0);
    this.layerMask = mask;
    this.renderer.set_layers(mask);
    this.invalidate();
  }
  setOffline(offline: boolean) {
    this.reader.offline = offline;
    this.tiles.retry();
    this.labels.retry();
    this.placesFailed = false;
    this.invalidate();
  }
  setGrid(grid: boolean) {
    this.grid = grid;
    this.invalidate();
  }
  private visibleTiles() {
    const { minZoom, maxZoom } = this.reader.index.manifest;
    const z = Math.max(minZoom, Math.min(maxZoom, Math.floor(this.zoom)));
    const n = 2 ** z;
    // Include bases just outside the view whose roofs rise into it.
    const padding =
      ((this.scene.extrude && (this.layerMask & 4) !== 0 && z >= 13
        ? this.scene.heightScale *
          ((this.reader.index.manifest.buildingHeights?.maxMeters ?? 0) +
            this.scene.fallbackHeight)
        : 0) /
        metersPerPixel(this.camera)) *
      Math.sin((this.scene.pitch * Math.PI) / 180);
    const [w, north, e, south] = cameraBounds(this.camera, padding);
    const range: [number, number, number, number, number] = [
      z,
      Math.max(0, Math.floor(w * n)),
      Math.min(n - 1, Math.floor(e * n)),
      Math.max(0, Math.floor(north * n)),
      Math.min(n - 1, Math.floor(south * n)),
    ];
    const layers = MAP_LAYERS.filter(
      (l) => (this.layerMask & LAYER_MASKS[l]) !== 0,
    );
    return {
      range,
      layers,
      bounds: [w, north, e, south] as [number, number, number, number],
    };
  }
  get memory() {
    return {
      reader: this.reader.memory,
      meshes: this.tiles.memory,
      labels: this.labels.memory,
    };
  }
  invalidate() {
    if (!this.frame && !this.dead)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.update();
      });
  }
  private update() {
    if (this.dead) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (width === 0 || height === 0) return;
    for (const c of [this.canvas, this.overlay]) {
      if (c.width !== Math.round(width * ratio))
        c.width = Math.round(width * ratio);
      if (c.height !== Math.round(height * ratio))
        c.height = Math.round(height * ratio);
    }
    const state = this.tiles.update(this.visibleTiles());
    const start = performance.now();
    this.triangles = this.renderer.render(
      ...this.center,
      this.zoom,
      width,
      height,
      ratio,
      this.scene.pitch,
      this.scene.bearing,
      this.scene.extrude ? this.scene.heightScale : 0,
      this.scene.fallbackHeight,
      this.scene.shading,
    );
    this.lastDraw = performance.now() - start;
    this.drawOverlay(width, height, ratio, state.view);
    this.onStats({
      zoom: this.zoom,
      tiles: state.tiles,
      wanted: state.wanted,
      missing: state.missing,
      triangles: this.triangles,
      fallbackTiles: state.presented.filter((b) => b.z !== state.view.zoom)
        .length,
      drawMs: this.lastDraw,
      loading: state.loading,
      labels: this.labelStats,
    });
  }
  private visiblePlaces(): Place[] {
    if (!this.placeNames) return [];
    if (!this.reader.index.blocks.some((b) => b.key === PLACE_LABEL_KEY))
      return this.reader.index.manifest.places;
    if (!this.places && !this.placesLoading && !this.placesFailed) {
      this.placesLoading = true;
      this.reader
        .block(PLACE_LABEL_KEY)
        .then((bytes) => {
          if (!this.dead) this.places = decodePlaces(bytes);
        })
        .catch((e) => {
          if (!this.dead) {
            this.placesFailed = true;
            this.onError(String(e));
          }
        })
        .finally(() => {
          this.placesLoading = false;
          this.invalidate();
        });
    }
    return this.places ?? [];
  }
  private drawOverlay(
    width: number,
    height: number,
    ratio: number,
    view: import("./tile-presentation").TileView,
  ) {
    const ctx = this.overlay.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const frame = {
      ctx,
      camera: this.camera,
      style: this.style,
      view,
      resident: (key: string) => this.tiles.has(key),
      cached: (key: string) =>
        this.storedKeys.has(key) ||
        this.reader.cache.has(key) ||
        this.tiles.has(key),
      labels: this.labels,
      features: this.featureOverlay,
      places: this.visiblePlaces(),
      placesLoading: this.placesLoading,
      placesMissing:
        this.placeNames &&
        !this.places &&
        this.reader.index.blocks.some((b) => b.key === PLACE_LABEL_KEY),
      state: {
        routingCells: this.routingCells,
        reachable: this.reachable,
        selection: this.selection,
        grid: this.grid,
        cache: this.cacheView,
        route: this.route,
        endpoints: this.endpoints,
        location: this.location,
        selected: this.selected,
      },
      labelStats: { roads: 0, pois: 0, loading: 0, missing: 0 },
    };
    this.overlays.draw(frame);
    this.labelStats = frame.labelStats;
  }
  destroy() {
    if (this.picker) this.endPicking(this.picker.owner);
    this.dead = true;
    this.labels.destroy();
    this.overlays.destroy();
    this.tiles.destroy();
    cancelAnimationFrame(this.frame);
    this.input.destroy();
    this.observer.disconnect();
    this.renderer.clear();
    this.renderer.free();
    this.overlay.remove();
  }
}
