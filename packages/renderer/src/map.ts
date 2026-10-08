import { TilePresentation, type TileView } from "./tile-presentation";
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
  projectScreen,
  worldToScreen,
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
  grid = false;
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
  private loaded = new Set<string>();
  private presentation = new TilePresentation();
  private loading = new Set<string>();
  private failed = new Set<string>();
  private wanted: string[] = [];
  private catalogLoading = new Set<string>();
  private catalogFailed = new Set<string>();
  private catalogMissing = 0;
  private dead = false;
  private frame = 0;
  private drag: {
    mode: "pan" | "orbit";
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null = null;
  private abort = new AbortController();
  private observer: ResizeObserver;
  private lastDraw = 0;
  private triangles = 0;
  private overlay: HTMLCanvasElement;
  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly reader: AtlasReader,
    readonly onStats: (stats: MapStats) => void,
    readonly onError: (message: string) => void,
  ) {
    this.labels = new MapLabels(reader, () => this.invalidate(), onError);
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
    const map = new AtlasMap(canvas, reader, onStats, onError);
    map.renderer = new Renderer(canvas);
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
    const options = { signal: this.abort.signal };
    this.canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (this.drag || ![0, 2].includes(event.button)) return;
        event.preventDefault();
        this.canvas.focus({ preventScroll: true });
        this.drag = {
          mode:
            event.button === 2 || event.metaKey || event.ctrlKey
              ? "orbit"
              : "pan",
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        this.canvas.setPointerCapture(event.pointerId);
      },
      options,
    );
    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!this.drag || this.drag.pointerId !== event.pointerId) return;
        if (
          Math.hypot(
            event.clientX - this.drag.startX,
            event.clientY - this.drag.startY,
          ) > 5
        )
          this.drag.moved = true;
        if (!this.drag.moved) return;
        if (this.drag.mode === "orbit") {
          this.orbit(event.clientX - this.drag.x, event.clientY - this.drag.y);
          this.drag.x = event.clientX;
          this.drag.y = event.clientY;
          return;
        }
        const scale = 256 * 2 ** this.zoom;
        const [dx, dy] = groundDelta(
          event.clientX - this.drag.x,
          event.clientY - this.drag.y,
          this.scene.pitch,
          this.scene.bearing,
        );
        this.center = [
          this.center[0] - dx / scale,
          this.center[1] - dy / scale,
        ];
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        this.invalidate();
      },
      options,
    );
    this.canvas.addEventListener(
      "pointerup",
      (event) => {
        if (!this.drag || this.drag.pointerId !== event.pointerId) return;
        if (this.drag.mode === "orbit") {
          this.drag = null;
          return;
        }
        const wasPicking = !!this.picker;
        if (this.drag && !this.drag.moved && this.picker) {
          const box = this.canvas.getBoundingClientRect();
          this.picker?.choose(
            unproject(
              ...screenToWorld(
                [event.clientX - box.left, event.clientY - box.top],
                this.camera,
              ),
            ),
          );
        }
        if (this.drag && !this.drag.moved && !wasPicking) {
          const box = this.canvas.getBoundingClientRect();
          const feature = this.featureOverlay.pick(
            this.overlay.getContext("2d")!,
            event.clientX - box.left,
            event.clientY - box.top,
          );
          if (feature) {
            this.onFeatureSelect?.(feature);
            this.drag = null;
            return;
          }
          const poi = this.labels.pick(
            event.clientX - box.left,
            event.clientY - box.top,
          );
          if (poi) this.onPoiSelect?.(poi);
        }
        this.drag = null;
      },
      options,
    );
    for (const name of ["pointercancel", "lostpointercapture"])
      this.canvas.addEventListener(
        name,
        () => {
          this.drag = null;
        },
        options,
      );
    this.canvas.addEventListener(
      "contextmenu",
      (event) => event.preventDefault(),
      options,
    );
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? this.canvas.clientHeight
              : 1;
        if (event.metaKey) {
          this.orbit(event.deltaX * unit, event.deltaY * unit);
          return;
        }
        const box = this.canvas.getBoundingClientRect();
        this.zoomAt(
          this.zoom - event.deltaY * unit * 0.002,
          event.clientX - box.left - box.width / 2,
          event.clientY - box.top - box.height / 2,
        );
      },
      { ...options, passive: false },
    );
    this.canvas.addEventListener(
      "keydown",
      (event) => {
        const shifts: Record<string, [number, number]> = {
          ArrowLeft: [-80, 0],
          ArrowRight: [80, 0],
          ArrowUp: [0, -80],
          ArrowDown: [0, 80],
        };
        if (event.key === "Enter" && this.picker) {
          event.preventDefault();
          if (this.picker.finish) this.picker.finish();
          else this.picker.choose(unproject(...this.center));
        } else if (event.key === " " && this.picker) {
          event.preventDefault();
          this.picker.choose(unproject(...this.center));
        } else if (event.key === "Escape" && this.picker) {
          const cancel = this.picker.cancel;
          this.endPicking(this.picker.owner);
          cancel();
        } else if (
          shifts[event.key] &&
          (event.metaKey || event.ctrlKey || event.shiftKey)
        ) {
          event.preventDefault();
          this.orbit(shifts[event.key]![0] / 4, shifts[event.key]![1] / 4);
        } else if (event.key.toLowerCase() === "r") {
          event.preventDefault();
          this.resetView();
        } else if (shifts[event.key]) {
          event.preventDefault();
          const [x, y] = groundDelta(
            ...shifts[event.key]!,
            this.scene.pitch,
            this.scene.bearing,
          );
          this.center = [
            this.center[0] + x / (256 * 2 ** this.zoom),
            this.center[1] + y / (256 * 2 ** this.zoom),
          ];
          this.invalidate();
        } else if (event.key === "+" || event.key === "=") this.zoomBy(1);
        else if (event.key === "-") this.zoomBy(-1);
      },
      options,
    );
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
    const points = [
      ...this.route.coordinates,
      ...this.endpoints.filter((p): p is Position => p !== null),
    ].map((p) => project(...p));
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
    this.failed.clear();
    this.catalogFailed.clear();
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
    const known = this.reader.tilesCached(...range, layers),
      key = `${range.join("/")}/${layers.join(",")}`;
    this.catalogMissing = known.complete ? 0 : 1;
    if (
      !known.complete &&
      !this.reader.offline &&
      !this.catalogLoading.has(key) &&
      !this.catalogFailed.has(key)
    ) {
      this.catalogLoading.add(key);
      this.reader
        .tiles(...range, layers)
        .catch((e) => {
          if (!this.dead) {
            this.catalogFailed.add(key);
            this.onError(String(e));
          }
        })
        .finally(() => {
          this.catalogLoading.delete(key);
          this.invalidate();
        });
    }
    return {
      blocks: known.blocks,
      complete: known.complete,
      zoom: z,
      layers,
      bounds: [w, north, e, south],
    } satisfies TileView;
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
    const view = this.visibleTiles(),
      visible = view.blocks;
    this.wanted = visible.map((b) => b.key);
    const presented = this.presentation.select(view, this.loaded);
    const retained = new Set([...this.wanted, ...presented.map((b) => b.key)]);
    for (const key of this.loaded) {
      if (!retained.has(key)) {
        this.renderer.remove_tile(key);
        this.loaded.delete(key);
      }
    }
    this.renderer.set_visible(presented.map((b) => b.key).join(","));
    for (const block of visible) {
      if (this.loading.size >= 6) break;
      if (
        this.loaded.has(block.key) ||
        this.loading.has(block.key) ||
        this.failed.has(block.key)
      )
        continue;
      if (this.reader.offline && !this.reader.cache.has(block.key)) continue;
      this.loading.add(block.key);
      this.reader
        .block(block.key)
        .then((bytes) => {
          if (this.dead || !this.wanted.includes(block.key)) return;
          this.renderer.add_tile_part(
            block.key,
            block.z!,
            block.x!,
            block.y!,
            bytes,
          );
          this.loaded.add(block.key);
        })
        .catch((error) => {
          if (this.dead) return;
          this.failed.add(block.key);
          this.onError(String(error));
        })
        .finally(() => {
          this.loading.delete(block.key);
          this.invalidate();
        });
    }
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
    this.drawOverlay(width, height, ratio);
    this.onStats({
      zoom: this.zoom,
      tiles: this.wanted.filter((key) => this.loaded.has(key)).length,
      wanted: this.wanted.length,
      missing:
        this.wanted.filter((key) => !this.loaded.has(key)).length +
        this.catalogMissing,
      triangles: this.triangles,
      fallbackTiles: presented.filter((b) => b.z !== view.zoom).length,
      drawMs: this.lastDraw,
      loading: this.loading.size + this.catalogLoading.size,
      labels: this.labelStats,
    });
  }
  private visiblePlaces(): Place[] {
    if (!this.placeNames) return [];
    if (!this.reader.index.blocks.some((b) => b.key === PLACE_LABEL_KEY))
      return this.reader.index.manifest.places;
    if (
      !this.places &&
      !this.placesLoading &&
      !this.placesFailed &&
      (!this.reader.offline || this.reader.cache.has(PLACE_LABEL_KEY))
    ) {
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
  private drawOverlay(width: number, height: number, ratio: number) {
    const ctx = this.overlay.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const world = 256 * 2 ** this.zoom;
    const screen = (lon: number, lat: number) =>
      projectScreen([lon, lat], this.camera);
    if (this.selection?.points.length) {
      ctx.beginPath();
      this.selection.points.forEach((p, i) => {
        const [x, y] = screen(...p);
        if (i === 0) ctx.moveTo(x!, y!);
        else ctx.lineTo(x!, y!);
      });
      if (this.selection.closed) ctx.closePath();
      ctx.fillStyle = "#507b4325";
      ctx.fill();
      ctx.strokeStyle = "#345d48";
      ctx.lineWidth = 2.5;
      ctx.setLineDash(this.selection.closed ? [] : [6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of this.selection.points) {
        const [x, y] = screen(...p);
        ctx.beginPath();
        ctx.arc(x!, y!, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#fbfaf5";
        ctx.fill();
        ctx.stroke();
      }
    }
    if (this.grid) {
      ctx.lineWidth = 1;
      ctx.font = "10px monospace";
      for (const b of this.visibleTiles().blocks) {
        const n = 2 ** b.z!;
        const corners = [
          [b.x! / n, b.y! / n],
          [(b.x! + 1) / n, b.y! / n],
          [(b.x! + 1) / n, (b.y! + 1) / n],
          [b.x! / n, (b.y! + 1) / n],
        ].map((p) => worldToScreen(p as [number, number], this.camera));
        ctx.strokeStyle = this.loaded.has(b.key) ? "#65897688" : "#c65b47";
        ctx.beginPath();
        corners.forEach(([x, y], i) =>
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
        );
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = this.style.labels.color;
        ctx.fillText(
          `${b.z}/${b.x}/${b.y}`,
          corners[0]![0] + 6,
          corners[0]![1] + 15,
        );
      }
    }
    ctx.font = `500 ${12 * this.style.labels.scale}px "Avenir Next", sans-serif`;
    ctx.textAlign = "center";
    this.featureOverlay.draw(ctx, this.camera);
    const occupied: Array<[number, number]> = [];
    for (const place of this.visiblePlaces()) {
      const [x, y] = screen(...place.coordinates);
      if (
        x! < 25 ||
        y! < 25 ||
        x! > width - 25 ||
        y! > height - 25 ||
        occupied.some(
          ([a, b]) =>
            Math.abs(a - x!) < 85 * this.style.labels.scale &&
            Math.abs(b - y!) < 23 * this.style.labels.scale,
        )
      )
        continue;
      occupied.push([x!, y!]);
      ctx.strokeStyle = this.style.labels.halo;
      ctx.lineWidth = 3;
      ctx.strokeText(place.name, x!, y!);
      ctx.fillStyle = this.style.labels.color;
      ctx.fillText(place.name, x!, y!);
    }
    this.labelStats = this.labels.draw(
      ctx,
      this.camera,
      this.style.labels,
      occupied.map(([x, y]) => [
        x - 44 * this.style.labels.scale,
        y - 12 * this.style.labels.scale,
        x + 44 * this.style.labels.scale,
        y + 5 * this.style.labels.scale,
      ]),
    );
    this.labelStats.places = occupied.length;
    this.labelStats.loading += this.placesLoading ? 1 : 0;
    this.labelStats.missing +=
      this.placeNames &&
      !this.places &&
      this.reader.index.blocks.some((b) => b.key === PLACE_LABEL_KEY)
        ? 1
        : 0;
    if (this.route) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      this.route.coordinates.forEach((p, i) => {
        const [x, y] = screen(...p);
        if (i === 0) ctx.moveTo(x!, y!);
        else ctx.lineTo(x!, y!);
      });
      ctx.strokeStyle = "#fff8e9";
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = "#be5438";
      ctx.lineWidth = 4;
      ctx.stroke();
      // Dotted offsets show snapping, not a claimed walkable connection.
      [this.route.start.coordinates, this.route.end.coordinates].forEach(
        (p, i) => {
          const request = this.endpoints[i];
          if (!request) return;
          const [x, y] = screen(...request),
            [sx, sy] = screen(...p);
          ctx.beginPath();
          ctx.moveTo(x!, y!);
          ctx.lineTo(sx!, sy!);
          ctx.strokeStyle = "#be5438";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        },
      );
    }
    this.endpoints.forEach((p, i) => {
      if (!p) return;
      const [x, y] = screen(...p);
      ctx.beginPath();
      ctx.arc(x!, y!, 13, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "#345d48" : "#be5438";
      ctx.fill();
      ctx.strokeStyle = "#fff8e9";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff8e9";
      ctx.font = 'bold 12px "Avenir Next", sans-serif';
      ctx.fillText(i === 0 ? "A" : "B", x!, y!);
      ctx.textBaseline = "alphabetic";
    });
    if (this.location) {
      const selected = this.location;
      if (selected.street) {
        ctx.beginPath();
        selected.street.forEach((p, i) => {
          const [x, y] = screen(...p);
          if (i === 0) ctx.moveTo(x!, y!);
          else ctx.lineTo(x!, y!);
        });
        ctx.strokeStyle = "#fff9e9";
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.strokeStyle = "#39708a";
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      const [x, y] = screen(...selected.coordinates);
      if (selected.requested) {
        const [rx, ry] = screen(...selected.requested);
        ctx.beginPath();
        ctx.moveTo(rx!, ry!);
        ctx.lineTo(x!, y!);
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#39708a";
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(rx!, ry!, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff9e9";
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x!, y!, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#39708a";
      ctx.fill();
      ctx.strokeStyle = "#fff9e9";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = '600 12px "Avenir Next", sans-serif';
      ctx.textAlign = "center";
      ctx.strokeText(selected.name, x!, y! - 17);
      ctx.fillStyle = "#254e63";
      ctx.fillText(selected.name, x!, y! - 17);
    }
    if (this.selected) {
      const [x, y] = screen(...this.selected.coordinates);
      ctx.beginPath();
      ctx.arc(x!, y!, 12, 0, Math.PI * 2);
      ctx.fillStyle = "#d15b37";
      ctx.fill();
      ctx.strokeStyle = "#fff8e9";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = '600 13px "Avenir Next", sans-serif';
      ctx.strokeText(this.selected.name, x!, y! - 23);
      ctx.fillStyle = "#693923";
      ctx.fillText(this.selected.name, x!, y! - 23);
    }
    const [, lat] = unproject(...this.center);
    const metersPerPixel =
      (Math.cos((lat * Math.PI) / 180) * 40075016.686) / world;
    const ideal = 110 * metersPerPixel;
    const base = 10 ** Math.floor(Math.log10(ideal));
    const distance =
      [1, 2, 5, 10]
        .map((n) => n * base)
        .filter((n) => n <= ideal)
        .pop() ?? base;
    const pixels = distance / metersPerPixel;
    ctx.strokeStyle = this.style.labels.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(24, height - 39);
    ctx.lineTo(24, height - 34);
    ctx.lineTo(24 + pixels, height - 34);
    ctx.lineTo(24 + pixels, height - 39);
    ctx.stroke();
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = this.style.labels.color;
    ctx.fillText(
      distance >= 1000 ? `${distance / 1000} km` : `${distance} m`,
      24,
      height - 44,
    );
  }
  destroy() {
    if (this.picker) this.endPicking(this.picker.owner);
    this.dead = true;
    this.labels.destroy();
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.observer.disconnect();
    this.renderer.clear();
    this.renderer.free();
    this.overlay.remove();
  }
}
