import { BudgetCache } from "../../format/src/cache";
import type { AtlasReader } from "../../format/src/reader";
import type { Block, MapLayer } from "../../format/src/index";
import { TilePresentation, type TileView } from "./tile-presentation";
export interface TileBackend {
  upload(block: Block, bytes: Uint8Array): number;
  remove(key: string): void;
  show(keys: string[]): void;
}
export interface TileRequest {
  /** Invalidates source-coverage filtering without dropping resident meshes. */
  revision?: number;
  range: [number, number, number, number, number];
  layers: MapLayer[];
  bounds: [number, number, number, number];
}
/** Owns asynchronous catalog/payload work, transition coverage and GPU lifetime.
 * Visible/fallback meshes are pinned. Spare meshes use the remaining LRU budget. */
export class TileScheduler {
  private meshes: BudgetCache<string, number>;
  private presentation = new TilePresentation();
  private loading = new Set<string>();
  private ready = new Map<string, { block: Block; bytes: Uint8Array }>();
  private failed = new Set<string>();
  private wanted = new Set<string>();
  private catalog?: { key: string; blocks: Block[] };
  private catalogPending?: string;
  private catalogFailed?: string;
  private current = "";
  private dead = false;
  uploads = 0;
  prepareMs = 0;
  constructor(
    private reader: Pick<AtlasReader, "tiles" | "tilesCached" | "block">,
    private backend: TileBackend,
    private invalidate: () => void,
    private error: (message: string) => void,
    budget = 96 * 1024 * 1024,
  ) {
    this.meshes = new BudgetCache(
      budget,
      (bytes) => bytes,
      (_, key) => backend.remove(key),
    );
  }
  get memory() {
    return {
      ...this.meshes.stats,
      uploads: this.uploads,
      prepareMs: this.prepareMs,
    };
  }
  has(key: string) {
    return this.meshes.has(key);
  }
  retry() {
    this.failed.clear();
    this.catalogFailed = undefined;
  }
  update(request: TileRequest) {
    const { range, layers, bounds } = request;
    const key = `${request.revision ?? 0}/${range.join("/")}/${layers.join(",")}`;
    this.current = key;
    const known =
      this.catalog?.key === key
        ? { complete: true, blocks: this.catalog.blocks }
        : this.reader.tilesCached(...range, layers);
    if (!known.complete && !this.catalogPending && this.catalogFailed !== key) {
      this.catalogPending = key;
      this.reader
        .tiles(...range, layers)
        .then((blocks) => {
          if (!this.dead && this.current === key)
            this.catalog = { key, blocks };
        })
        .catch((e) => {
          if (!this.dead && this.current === key) {
            this.catalogFailed = key;
            this.error(String(e));
          }
        })
        .finally(() => {
          this.catalogPending = undefined;
          if (!this.dead) this.invalidate();
        });
    }
    const view: TileView = { ...known, zoom: range[0], layers, bounds };
    this.wanted = new Set(known.blocks.map((b) => b.key));
    for (const k of this.failed) if (!this.wanted.has(k)) this.failed.delete(k);
    for (const k of this.ready.keys())
      if (!this.wanted.has(k)) this.ready.delete(k);
    const presented = this.presentation.select(
      view,
      new Set(this.meshes.keys()),
    );
    this.meshes.protect([...this.wanted, ...presented.map((b) => b.key)]);
    for (const k of this.wanted) this.meshes.get(k);
    for (const b of presented) this.meshes.get(b.key);
    this.backend.show(presented.map((b) => b.key));
    // Upload a bounded batch per frame; network completions never triangulate
    // synchronously. A single expensive mesh can still exceed this time slice.
    const start = performance.now();
    for (const [k, job] of this.ready) {
      this.ready.delete(k);
      try {
        const bytes = this.backend.upload(job.block, job.bytes);
        this.meshes.set(k, bytes);
        this.uploads++;
      } catch (e) {
        this.failed.add(k);
        this.error(String(e));
      }
      this.invalidate();
      if (performance.now() - start >= 4) break;
    }
    this.prepareMs += performance.now() - start;
    for (const block of known.blocks) {
      if (this.loading.size + this.ready.size >= 6) break;
      if (
        this.meshes.has(block.key) ||
        this.loading.has(block.key) ||
        this.ready.has(block.key) ||
        this.failed.has(block.key)
      )
        continue;
      this.loading.add(block.key);
      this.reader
        .block(block.key)
        .then((bytes) => {
          if (!this.dead && this.wanted.has(block.key))
            this.ready.set(block.key, { block, bytes });
        })
        .catch((e) => {
          if (!this.dead && this.wanted.has(block.key)) {
            this.failed.add(block.key);
            this.error(String(e));
          }
        })
        .finally(() => {
          this.loading.delete(block.key);
          if (!this.dead) this.invalidate();
        });
    }
    return {
      view,
      presented,
      wanted: this.wanted.size,
      tiles: [...this.wanted].filter((k) => this.meshes.has(k)).length,
      missing:
        [...this.wanted].filter((k) => !this.meshes.has(k)).length +
        (known.complete ? 0 : 1),
      loading:
        this.loading.size + this.ready.size + (this.catalogPending ? 1 : 0),
    };
  }
  destroy() {
    this.dead = true;
    this.ready.clear();
    this.catalog = undefined;
    this.meshes.clear();
  }
}
