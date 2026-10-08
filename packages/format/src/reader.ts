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
  if (key.startsWith("tile/")) return "map";
  if (key.startsWith("features/") && key !== "features/geojson")
    return "features";
  if (key === "labels/places") return "placeNames";
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
  read(start: number, end: number): Promise<Uint8Array>;
}
export class HttpSource implements ByteSource {
  private etag?: string;
  constructor(readonly url: string) {}
  async read(start: number, end: number) {
    const headers: Record<string, string> = {
      Range: `bytes=${start}-${end - 1}`,
    };
    if (this.etag) headers["If-Match"] = this.etag;
    const response = await fetch(this.url, { headers, cache: "no-store" });
    if (response.status === 412)
      throw new Error(
        "Package changed on the server. Reopen it to use the new snapshot.",
      );
    if (response.status !== 206)
      throw new Error(
        `Range server returned HTTP ${response.status}; expected 206`,
      );
    const etag = response.headers.get("etag");
    if (!etag || etag.startsWith("W/"))
      throw new Error("Range server must provide a strong ETag");
    if (this.etag && etag !== this.etag)
      throw new Error("Snapshot changed during read");
    this.etag = etag;
    const range = response.headers.get("content-range");
    if (!range?.startsWith(`bytes ${start}-${end - 1}/`))
      throw new Error("Server returned the wrong byte range");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start)
      throw new Error("Truncated range response");
    return bytes;
  }
}
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
  readonly cache = new Map<string, Uint8Array>();
  private pending = new Map<string, Promise<Uint8Array>>();
  private loadedPages = new Set<string>();
  private pageRequests = new Map<string, Promise<void>>();
  private byKey = new Map<string, Block>();
  constructor(
    readonly source: ByteSource,
    readonly onRead?: (event: ReadEvent) => void,
    readonly options: { purposes?: readonly DataPurpose[] } = {},
  ) {}
  async open() {
    const header = parseHeader(await this.readRange("header", 0, HEADER_SIZE));
    this.index = parseIndex(
      header,
      await this.readRange("index", HEADER_SIZE, header.payloadOffset),
    );
    this.byKey = new Map(this.index.blocks.map((b) => [b.key, b]));
    return this;
  }
  private async readRange(key: string, start: number, end: number) {
    const bytes = await this.source.read(start, end);
    this.requests++;
    this.bytesRead += bytes.length;
    this.bytesByPurpose[purposeOf(key)] += bytes.length;
    if (key.startsWith("tile/"))
      this.bytesByLayer[tileLayer(key) ?? "combined"] += bytes.length;
    this.onRead?.({ key, start, end, bytes: bytes.length, cached: false });
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
  private async loadPage(page: IndexPage): Promise<void> {
    if (this.loadedPages.has(page.key)) return;
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
      for (const b of blocks) this.byKey.set(b.key, b);
      this.loadedPages.add(page.key);
      this.cache.delete(page.key); // Retain parsed descriptors, not a duplicate JSON buffer.
    })();
    this.pageRequests.set(page.key, task);
    try {
      await task;
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
        this.pagesFor(prefix, z, xmin, xmax, ymin, ymax).every((p) =>
          this.loadedPages.has(p.key),
        ),
      ),
      blocks: [...this.byKey.values()].filter(
        (b) =>
          b.key.startsWith("tile/") &&
          prefixes.includes(
            tileLayer(b.key) ? `tile/${tileLayer(b.key)}` : "tile",
          ) &&
          b.z === z &&
          b.x! >= xmin &&
          b.x! <= xmax &&
          b.y! >= ymin &&
          b.y! <= ymax,
      ),
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
    await Promise.all(
      this.tilePrefixes(layers)
        .flatMap((prefix) => this.pagesFor(prefix, z, xmin, xmax, ymin, ymax))
        .map((p) => this.loadPage(p)),
    );
    return this.tilesCached(z, xmin, xmax, ymin, ymax, layers).blocks;
  }
  async spatial(
    prefix: string,
    z: number,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
  ) {
    await Promise.all(
      this.pagesFor(prefix, z, xmin, xmax, ymin, ymax).map((p) =>
        this.loadPage(p),
      ),
    );
    return [...this.byKey.values()].filter((b) => {
      const a = spatialAddress(b.key);
      return (
        a?.prefix === prefix &&
        a.z === z &&
        a.x >= xmin &&
        a.x <= xmax &&
        a.y >= ymin &&
        a.y <= ymax
      );
    });
  }
  /** Explicit full-catalog operation for auditing, never needed to display a view. */
  async allBlocks() {
    for (const page of this.index.pages) await this.loadPage(page);
    return [...this.byKey.values()].sort((a, b) => a.offset - b.offset);
  }
  async block(key: string): Promise<Uint8Array> {
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
    const address = spatialAddress(key);
    if (!this.byKey.has(key) && address) {
      const a = address;
      await this.spatial(a.prefix, a.z, a.x, a.x, a.y, a.y);
    }

    const block = this.byKey.get(key);
    if (!block) throw new Error(`Block not present in this package: ${key}`);
    return this.readBlock(block);
  }
  private async readBlock(block: Block): Promise<Uint8Array> {
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
    if (this.offline) throw new Error(`Not cached: ${key}`);
    const request = (async () => {
      const bytes = await this.readRange(key, start, start + block.length);
      if ((await sha256(bytes)) !== block.hash)
        throw new Error(`Integrity check failed: ${key}`);
      const decoded =
        block.codec === "gzip"
          ? await decompress(bytes, block.rawLength!)
          : bytes;
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
    const peaks = JSON.parse(
      new TextDecoder().decode(await this.block("query/peaks")),
    ) as Peak[];
    if (
      !Array.isArray(peaks) ||
      !peaks.every(
        (p) =>
          typeof p.name === "string" &&
          Array.isArray(p.coordinates) &&
          p.coordinates.length === 2 &&
          p.coordinates.every(Number.isFinite) &&
          (p.elevation === null || Number.isFinite(p.elevation)),
      )
    )
      throw new Error("Invalid peak query block");
    const known = peaks
      .filter((p) => p.elevation !== null)
      .sort((a, b) => b.elevation! - a.elevation!);
    return {
      peak: known[0] ?? null,
      known: known.length,
      unknown: peaks.length - known.length,
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
