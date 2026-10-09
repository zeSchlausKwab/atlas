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
export interface CompositionStats {
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
export class CompositionMap {
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
    private canvas: HTMLCanvasElement,
    private onStats: (stats: CompositionStats) => void,
    private onError: (id: string, error: string) => void,
  ) {
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
        this.invalidate();
      },
      zoom: (delta, x, y) => this.zoomBy(delta, x, y),
      click: () => {},
      command: (c) => {
        if (c === "reset") this.reset();
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
    this.pitch = 0;
    this.bearing = 0;
    this.invalidate();
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
    for (const part of planComposition(this.sources, Math.floor(this.zoom))) {
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
        missing: 0,
        loading: 0,
        sources: 0,
        triangles: 0,
        bytes: 0,
      };
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
      stats.tiles += result.tiles;
      stats.missing += result.missing;
      stats.loading += result.loading;
      stats.bytes += s.source.reader.bytesRead;
      if (active && (layers.length || s.tiles.parts.has("labels")))
        stats.sources++;
    }
    this.renderer.set_visible(visible.join(","));
    // Ground-plane composition: coverage masks have one unambiguous boundary.
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
        if (!s.places && !s.placesLoading && !s.placesFailed) {
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
        for (const place of s.places ?? []) {
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
        }
        const labels = s.labels.draw(
          ctx,
          camera,
          this.style.labels,
          occupied,
          accepts,
        );
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
    this.onStats(stats);
  }
  destroy() {
    if (this.dead) return;
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
