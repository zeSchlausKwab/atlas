import { peakSummary } from "./peaks";
import {
  BudgetCache,
  DecodedCache,
  type DEFAULT_DECODED_BUDGETS,
} from "./cache";
import type { BlockStore } from "./store";
import {
  MAP_LAYERS,
  tileLayer,
  type MapLayer,
  HEADER_SIZE,
  INDEX_PAGE_SIZE,
  spatialAddress,
  validateBlocks,
  type IndexPage,
  parseHeader,
  parseIndex,
  sha256,
  type PackageIndex,
  type Block,
  type Peak,
} from "./index";
export type DataPurpose =
  | "map"
  | "labels"
  | "routing"
  | "search"
  | "queries"
  | "source"
  | "features";
export type TransferPurpose =
  | DataPurpose
  | "directory"
  | "placeNames"
  | "streetNames"
  | "pois";
export function purposeOf(key: string): TransferPurpose {
  if (key === "header" || key === "index" || key.startsWith("index/"))
    return "directory";
  if (
    key.startsWith("tile/") ||
    key.startsWith("raster/") ||
    key.startsWith("boundary-display/")
  )
    return "map";
  if (key.startsWith("boundaries/") || key.startsWith("objects/"))
    return "features";
  if (key.startsWith("features/") && key !== "features/geojson")
    return "features";
  if (key === "labels/places" || key.startsWith("labels/settlements/"))
    return "placeNames";
  if (key.startsWith("labels/"))
    return key.includes("/roads/")
      ? "streetNames"
      : key.includes("/pois/")
        ? "pois"
        : "labels";
  if (key.startsWith("routing/")) return "routing";
  if (key.startsWith("search/")) return "search";
  if (key.startsWith("query/")) return "queries";
  return "source";
}
export interface ReadEvent {
  key: string;
  start: number;
  end: number;
  bytes: number;
  cached: boolean;
}
export interface ByteSource {
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export { HttpSource } from "./http-source";
export { RemoteSource } from "./remote-source";
export class FileSource implements ByteSource {
  constructor(readonly file: Blob) {}
  async read(start: number, end: number) {
    if (end > this.file.size) throw new Error("Truncated local package");
    return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
  }
}
export class AtlasReader {
  index!: PackageIndex;
  offline = false;
  bytesRead = 0;
  readonly bytesByPurpose: Record<TransferPurpose, number> = {
    directory: 0,
    map: 0,
    labels: 0,
    placeNames: 0,
    streetNames: 0,
    pois: 0,
    routing: 0,
    search: 0,
    queries: 0,
    source: 0,
    features: 0,
  };
  readonly bytesByLayer: Record<MapLayer | "combined", number> = {
    land: 0,
    water: 0,
    buildings: 0,
    roads: 0,
    railways: 0,
    peaks: 0,
    combined: 0,
  };
  requests = 0;
  cacheHits = 0;
  readonly cache: DecodedCache;
  private disposed = false;
  private abort = new AbortController();
  private active() {
    if (this.disposed) throw new Error("Map session closed");
  }
  /** Invalidate late reads before clearing persistent storage. */
  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.cache.clear();
    this.pages.clear();
    this.byKey.clear();
  }
  private pending = new Map<string, Promise<Uint8Array>>();
  private pages: BudgetCache<string, Block[]>;
  private pageRequests = new Map<string, Promise<Block[]>>();
  private byKey = new Map<string, Block>();
  constructor(
    readonly source: ByteSource,
    readonly onRead?: (event: ReadEvent) => void,
    readonly options: {
      purposes?: readonly DataPurpose[];
      store?: BlockStore;
      sourceId?: string;
      cacheBudgets?: Partial<typeof DEFAULT_DECODED_BUDGETS>;
      /** Estimated retained descriptor bytes, excluding the immutable root. */
      directoryBudget?: number;
      /** Called before cached or fetched block decoding; scoped consumers enforce resource budgets here. */
      beforeBlock?: (block: Block) => void;
      /** Observe completed source transfers, including independent scoped forks. Cache hits do not transfer bytes. */
      onTransfer?: (event: ReadEvent) => void;
    } = {},
  ) {
    this.cache = new DecodedCache(options.cacheBudgets);
    this.pages = new BudgetCache(
      options.directoryBudget ?? 16 * 1024 * 1024,
      (blocks) =>
        blocks.reduce(
          (n, b) => n + 192 + b.key.length * 2 + b.hash.length * 2,
          0,
        ),
      (blocks) => {
        for (const b of blocks) this.byKey.delete(b.key);
      },
    );
  }
  /** An independent session pinned to this verified index; changing its policy never changes the map reader. */
  fork(options: AtlasReader["options"] = {}, source: ByteSource = this.source) {
    this.active();
    const reader = new AtlasReader(source, undefined, {
      ...this.options,
      ...options,
    });
    reader.index = structuredClone(this.index);
    reader.byKey = new Map(reader.index.blocks.map((b) => [b.key, b]));
    for (const [key, blocks] of this.pages) {
      for (const b of blocks) reader.byKey.set(b.key, b);
      reader.pages.set(key, blocks);
    }
    for (const [key, bytes] of this.cache) reader.cache.set(key, bytes);
    reader.offline = this.offline;
    return reader;
  }
  get memory() {
    return { decoded: this.cache.stats, directory: this.pages.stats };
  }
  async open() {
    this.active();
    let headerBytes: Uint8Array, indexBytes: Uint8Array;
    try {
      headerBytes = await this.readRange("header", 0, HEADER_SIZE);
      const header = parseHeader(headerBytes);
      indexBytes = await this.readRange(
        "index",
        HEADER_SIZE,
        header.payloadOffset,
      );
    } catch (error) {
      // Only transport failures permit using a previously validated snapshot.
      if (!(error instanceof TypeError) || !this.options.sourceId) throw error;
      const saved = await this.options.store?.getIndex(this.options.sourceId);
      if (!saved) throw error;
      headerBytes = saved.header;
      indexBytes = saved.index;
      this.offline = true;
    }
    this.active();
    this.index = parseIndex(parseHeader(headerBytes), indexBytes);
    this.byKey = new Map(this.index.blocks.map((b) => [b.key, b]));
    if (this.options.sourceId)
      await this.options.store?.putIndex(this.options.sourceId, {
        header: headerBytes,
        index: indexBytes,
      });
    return this;
  }
  private async readRange(key: string, start: number, end: number) {
    this.active();
    const bytes = await this.source.read(start, end, this.abort.signal);
    this.active();
    this.requests++;
    this.bytesRead += bytes.length;
    this.bytesByPurpose[purposeOf(key)] += bytes.length;
    if (key.startsWith("tile/"))
      this.bytesByLayer[tileLayer(key) ?? "combined"] += bytes.length;
    const event = { key, start, end, bytes: bytes.length, cached: false };
    this.onRead?.(event);
    this.options.onTransfer?.(event);
    return bytes;
  }
  private pagesFor(
    prefix: string,
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
  ) {
    return this.index.pages.filter(
      (p) =>
        (p.prefix ?? "tile") === prefix &&
        p.z === z &&
        p.x >= Math.floor(xmin / INDEX_PAGE_SIZE) &&
        p.x <= Math.floor(xmax / INDEX_PAGE_SIZE) &&
        p.y >= Math.floor(ymin / INDEX_PAGE_SIZE) &&
        p.y <= Math.floor(ymax / INDEX_PAGE_SIZE),
    );
  }
  private async loadPage(page: IndexPage): Promise<Block[]> {
    const cached = this.pages.get(page.key);
    if (cached) return cached;
    if (this.pageRequests.has(page.key))
      return this.pageRequests.get(page.key)!;
    const task = (async () => {
      const bytes = await this.readBlock(page);
      const blocks = JSON.parse(new TextDecoder().decode(bytes)) as Block[];
      validateBlocks(this.index.header, this.index.manifest, blocks);
      if (
        blocks.length !== page.count ||
        blocks.some((b) => {
          const a = spatialAddress(b.key);
          return (
            !a ||
            a.prefix !== (page.prefix ?? "tile") ||
            a.z !== page.z ||
            Math.floor(a.x / INDEX_PAGE_SIZE) !== page.x ||
            Math.floor(a.y / INDEX_PAGE_SIZE) !== page.y ||
            b.offset + b.length > this.index.pages[0]!.offset
          );
        })
      )
        throw new Error("Invalid directory page contents");
      this.active();
      for (const b of blocks) this.byKey.set(b.key, b);
      this.pages.set(page.key, blocks);
      this.cache.delete(page.key); // Retain parsed descriptors, not a duplicate JSON buffer.
      return blocks;
    })();
    this.pageRequests.set(page.key, task);
    try {
      return await task;
    } finally {
      this.pageRequests.delete(page.key);
    }
  }
  private tilePrefixes(layers: readonly MapLayer[]) {
    if (!layers.length) return [];
    return this.index.manifest.tileLayers
      ? layers
          .filter((l) => this.index.manifest.tileLayers!.includes(l))
          .map((l) => `tile/${l}`)
      : ["tile"];
  }
  tilesCached(
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
    layers: readonly MapLayer[] = MAP_LAYERS,
  ) {
    const prefixes = this.tilePrefixes(layers);
    return {
      complete: prefixes.every((prefix) =>
        this.pagesFor(prefix, z, xmin, xmax, ymin, ymax).every(
          (p) => this.pages.get(p.key) !== undefined,
        ),
      ),
      blocks: this.spatialCached(prefixes, z, xmin, xmax, ymin, ymax),
    };
  }
  async tiles(
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
    layers: readonly MapLayer[] = MAP_LAYERS,
  ) {
    return this.query(this.tilePrefixes(layers), z, xmin, xmax, ymin, ymax);
  }
  async spatial(
    prefix: string,
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
  ) {
    return this.query([prefix], z, xmin, xmax, ymin, ymax);
  }
  private async query(
    prefixes: string[],
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
  ) {
    const matches = (b: Block) => {
      const a = spatialAddress(b.key);
      return (
        a &&
        prefixes.includes(a.prefix) &&
        a.z === z &&
        a.x >= xmin &&
        a.x <= xmax &&
        a.y >= ymin &&
        a.y <= ymax
      );
    };
    const result = this.index.blocks.filter(matches);
    const pages = prefixes.flatMap((p) =>
      this.pagesFor(p, z, xmin, xmax, ymin, ymax),
    );
    // Collect owned results before LRU eviction. A broad query must not silently
    // lose its first pages when its descriptor working set exceeds the budget.
    for (let i = 0; i < pages.length; i += 8) {
      const batch = await Promise.allSettled(
        pages.slice(i, i + 8).map((p) => this.loadPage(p)),
      );
      // Drain the batch before releasing a scoped reader on cancellation/failure.
      // Promise.all would leave sibling reads racing the next preparation.
      for (const outcome of batch) {
        if (outcome.status === "rejected") throw outcome.reason;
        result.push(...outcome.value.filter(matches));
      }
    }
    return result.sort((a, b) => a.offset - b.offset);
  }
  /** Small viewport queries cost only their own addresses, not all visited tiles. */
  private spatialCached(
    prefixes: string[],
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
  ) {
    const result: Block[] = [];
    if ((xmax - xmin + 1) * (ymax - ymin + 1) * prefixes.length <= 65536) {
      for (const prefix of prefixes)
        for (let x = xmin; x <= xmax; x++)
          for (let y = ymin; y <= ymax; y++) {
            const b = this.byKey.get(`${prefix}/${z}/${x}/${y}`);
            if (b) result.push(b);
          }
    } else {
      for (const b of this.byKey.values()) {
        const a = spatialAddress(b.key);
        if (
          a &&
          prefixes.includes(a.prefix) &&
          a.z === z &&
          a.x >= xmin &&
          a.x <= xmax &&
          a.y >= ymin &&
          a.y <= ymax
        )
          result.push(b);
      }
    }
    return result.sort((a, b) => a.offset - b.offset);
  }

  /** Explicit full-catalog operation for auditing, never needed to display a view. */
  async *iterateBlocks(prefix = ""): AsyncGenerator<Block> {
    for (const b of this.index.blocks) if (b.key.startsWith(prefix)) yield b;
    for (const page of this.index.pages) {
      const family = `${page.prefix ?? "tile"}/`;
      if (prefix && !family.startsWith(prefix) && !prefix.startsWith(family))
        continue;
      for (const b of await this.loadPage(page))
        if (b.key.startsWith(prefix)) yield b;
    }
  }
  async allBlocks() {
    const result = [...this.index.blocks];
    for (const page of this.index.pages)
      result.push(...(await this.loadPage(page)));
    return result.sort((a, b) => a.offset - b.offset);
  }
  async block(key: string): Promise<Uint8Array> {
    this.active();
    const kind = purposeOf(key);
    const purpose =
      kind === "streetNames" || kind === "pois" || kind === "placeNames"
        ? "labels"
        : kind;
    if (
      this.options.purposes &&
      purpose !== "directory" &&
      !this.options.purposes.includes(purpose)
    )
      throw new Error(`Data purpose not enabled: ${purpose}`);
    // A verified decoded block remains usable even after its directory page was
    // evicted. In particular, cache-only mode must not refetch that page.
    if (!this.byKey.has(key)) {
      const bytes = this.cache.get(key);
      if (bytes) {
        this.cacheHits++;
        this.onRead?.({ key, start: 0, end: 0, bytes: 0, cached: true });
        return bytes;
      }
    }
    const address = spatialAddress(key);
    let block = this.byKey.get(key);
    if (!block && address) {
      const a = address;
      block = (await this.spatial(a.prefix, a.z, a.x, a.x, a.y, a.y)).find(
        (b) => b.key === key,
      );
    }
    if (!block) throw new Error(`Block not present in this package: ${key}`);
    return this.readBlock(block);
  }
  private async readBlock(block: Block): Promise<Uint8Array> {
    this.active();
    this.options.beforeBlock?.(block);
    const key = block.key;
    const start = this.index.header.payloadOffset + block.offset;
    const cached = this.cache.get(key);
    if (cached) {
      this.cacheHits++;
      this.onRead?.({
        key,
        start,
        end: start + block.length,
        bytes: 0,
        cached: true,
      });
      return cached;
    }
    if (this.pending.has(key)) return this.pending.get(key)!;
    const request = (async () => {
      const stored = await this.options.store?.get(
        this.index.manifest.snapshot,
        block,
      );
      this.active();
      if (!stored && this.offline) throw new Error(`Not cached: ${key}`);
      const bytes =
        stored ?? (await this.readRange(key, start, start + block.length));
      if (stored) {
        this.cacheHits++;
        this.onRead?.({
          key,
          start,
          end: start + block.length,
          bytes: 0,
          cached: true,
        });
      }
      if ((await sha256(bytes)) !== block.hash)
        throw new Error(`Integrity check failed: ${key}`);
      const decoded =
        block.codec === "gzip"
          ? await decompress(bytes, block.rawLength!)
          : bytes;
      this.active();
      if (!stored)
        await this.options.store?.put(
          this.index.manifest.snapshot,
          block,
          bytes,
        );
      this.active();
      this.cache.set(key, decoded);
      return decoded;
    })();
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
  async highestPeak(): Promise<{
    peak: Peak | null;
    known: number;
    unknown: number;
    snapshot: string;
    scope: string;
  }> {
    const result = peakSummary(
      JSON.parse(new TextDecoder().decode(await this.block("query/peaks"))),
    );
    return {
      ...result,
      snapshot: this.index.manifest.snapshot,
      scope:
        "Recorded peaks in this source extract; known numeric elevations only",
    };
  }
}

/** Enforce the declared decoded size while streaming, before caching the result. */
export async function decompress(
  bytes: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > 768 * 1024 * 1024)
    throw new Error("Invalid decoded block size");
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const output = new Uint8Array(length);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await stream.read();
      if (done) break;
      if (offset + value.length > length)
        throw new Error("Decoded block exceeds declared size");
      output.set(value, offset);
      offset += value.length;
    }
    if (offset !== length) throw new Error("Decoded block size mismatch");
    return output;
  } catch (error) {
    await stream.cancel().catch(() => {});
    throw error;
  }
}
