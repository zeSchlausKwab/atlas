import { Database } from "bun:sqlite";
import { open, rm, rename, mkdtemp, type FileHandle } from "node:fs/promises";
import { AtlasReader } from "../../format/src/reader";
import {
  HEADER_SIZE,
  MAX_METADATA,
  INDEX_PAGE_SIZE,
  spatialAddress,
  pageKey,
  sha256,
  validateBlocks,
  type Block,
  type IndexPage,
  type Manifest,
} from "../../format/src/index";
import {
  describeBlock,
  encodePrefix,
  type InputBlock,
} from "../../format/src/writer";
import { tileRecords } from "../../format/src/tiles";
const RESERVE = HEADER_SIZE + MAX_METADATA;
const decoder = new TextDecoder(),
  encoder = new TextEncoder();
async function write(file: FileHandle, bytes: Uint8Array, at: number) {
  for (let n = 0; n < bytes.length; ) {
    const r = await file.write(bytes, n, bytes.length - n, at + n);
    if (!r.bytesWritten) throw Error("Archive write stalled");
    n += r.bytesWritten;
  }
}
/** Augment water only. Preserve every existing payload address and copy untouched
 * directory leaves byte-for-byte; do not decode millions of unrelated blocks.
 * The input stays immutable. The caller validates the new archive before hosting it.
 */
export class WaterPatchWriter {
  private file!: FileHandle;
  private db!: Database;
  private ownsPart = false;
  private scratch = "";
  private length = 0;
  private addedFeatures = 0;
  private objectRoots: Block[] = [];
  private replacesObjects = false;
  constructor(
    readonly reader: AtlasReader,
    readonly output: string,
    readonly maxBytes: number,
    readonly signal: AbortSignal,
    readonly progress: (s: string) => void = () => {},
  ) {}
  private async stored(block: Block) {
    const start = this.reader.index.header.payloadOffset + block.offset;
    const bytes = await this.reader.source.read(
      start,
      start + block.length,
      this.signal,
    );
    if ((await sha256(bytes)) !== block.hash)
      throw Error(`Integrity check failed: ${block.key}`);
    return bytes;
  }
  private async entries(page: IndexPage) {
    const bytes = await this.stored(page);
    const entries = JSON.parse(
      decoder.decode(Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>)),
    ) as Block[];
    validateBlocks(
      this.reader.index.header,
      this.reader.index.manifest,
      entries,
    );
    if (
      entries.length !== page.count ||
      entries.some((b) => {
        const a = spatialAddress(b.key);
        return (
          !a ||
          a.prefix !== page.prefix ||
          a.z !== page.z ||
          Math.floor(a.x / INDEX_PAGE_SIZE) !== page.x ||
          Math.floor(a.y / INDEX_PAGE_SIZE) !== page.y
        );
      })
    )
      throw Error("Invalid water directory");
    return entries;
  }
  async open() {
    const { header, manifest, pages } = this.reader.index;
    if (header.version !== 2 || !manifest.tileLayers?.includes("water"))
      throw Error(
        "Ocean patch needs a paged archive with an independent water layer",
      );
    if (await Bun.file(this.output).exists())
      throw Error("Output already exists; choose a new archive path");
    this.file = await open(this.output + ".part", "wx+");
    this.ownsPart = true;
    this.scratch = await mkdtemp(this.output + ".patch-");
    this.db = new Database(this.scratch + "/index.sqlite", { create: true });
    this.db.run(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; CREATE TABLE old(key TEXT PRIMARY KEY,json TEXT) WITHOUT ROWID; CREATE TABLE changed(key TEXT PRIMARY KEY,page TEXT,json TEXT) WITHOUT ROWID; CREATE INDEX by_page ON changed(page); BEGIN",
    );
    const put = this.db.query("INSERT INTO old VALUES(?,?)");
    for (const page of pages.filter((p) => p.prefix === "tile/water")) {
      this.signal.throwIfAborted();
      for (const block of await this.entries(page))
        put.run(block.key, JSON.stringify(block));
    }
    this.db.run("COMMIT; BEGIN");
    // All spatial and root data are before the first leaf page. Offsets in the
    // copied data stay relative to the new payload, regardless of prefix size.
    const dataEnd =
      pages[0]?.offset ?? header.fileLength - header.payloadOffset;
    if (dataEnd + RESERVE > this.maxBytes)
      throw Error("Water patch exceeds output budget");
    for (let at = 0; at < dataEnd; ) {
      this.signal.throwIfAborted();
      const end = Math.min(at + 8 * 1024 ** 2, dataEnd);
      const bytes = await this.reader.source.read(
        header.payloadOffset + at,
        header.payloadOffset + end,
        this.signal,
      );
      await write(this.file, bytes, RESERVE + at);
      at = end;
      if (at % (256 * 1024 ** 2) === 0 || at === dataEnd)
        this.progress(`Copying unchanged map data: ${at}/${dataEnd} bytes`);
    }
    this.length = dataEnd;
    return this;
  }
  async addObjectBlock(input: InputBlock) {
    this.signal.throwIfAborted();
    if (!input.key.startsWith("objects/") || input.codec)
      throw Error("Expected an uncompressed source-object block");
    const zipped = Bun.gzipSync(input.bytes as Uint8Array<ArrayBuffer>);
    const stored: InputBlock =
      zipped.length < input.bytes.length
        ? {
            ...input,
            bytes: zipped,
            codec: "gzip",
            rawLength: input.bytes.length,
          }
        : input;
    const b = await describeBlock(stored, this.length);
    if (RESERVE + this.length + stored.bytes.length > this.maxBytes)
      throw Error("Ocean semantic data exceeds output budget");
    const a = spatialAddress(b.key);
    if (a)
      this.db
        .query("INSERT INTO changed VALUES(?,?,?)")
        .run(
          b.key,
          pageKey(
            a.prefix,
            a.z,
            Math.floor(a.x / INDEX_PAGE_SIZE),
            Math.floor(a.y / INDEX_PAGE_SIZE),
          ),
          JSON.stringify(b),
        );
    else {
      if (b.key !== "objects/index") throw Error("Unexpected object root");
      this.objectRoots.push(b);
      this.replacesObjects = true;
    }
    await write(this.file, stored.bytes, RESERVE + this.length);
    this.length += stored.bytes.length;
  }
  async add(input: InputBlock) {
    this.signal.throwIfAborted();
    const a = spatialAddress(input.key);
    if (a?.prefix !== "tile/water" || input.codec)
      throw Error("Water patch accepts uncompressed water tiles only");
    if (
      a.z < this.reader.index.manifest.minZoom ||
      a.z > this.reader.index.manifest.maxZoom ||
      a.x >= 2 ** a.z ||
      a.y >= 2 ** a.z
    )
      throw Error("Water tile is outside archive zoom range");
    const old = this.db
      .query<{ json: string }, [string]>("SELECT json FROM old WHERE key=?")
      .get(input.key);
    let bytes = input.bytes,
      features = 0;
    const original = old ? (JSON.parse(old.json) as Block) : undefined;
    let originalBytes: Uint8Array | undefined;
    if (original) {
      const stored = await this.stored(original);
      originalBytes =
        original.codec === "gzip"
          ? Bun.gunzipSync(stored as Uint8Array<ArrayBuffer>)
          : stored;
    }
    const parts = [bytes, ...(originalBytes ? [originalBytes] : [])];
    let points = 0,
      length = 8;
    for (const part of parts)
      for (const r of tileRecords(part)) {
        if (r.class !== 1) throw Error("Non-water geometry in water patch");
        points += r.pointCount;
        features++;
        length += r.end - r.start;
      }
    if (points > 3000000 || features > 500000 || length > 64 * 1024 ** 2)
      throw Error(`Merged water tile exceeds decoder budget: ${input.key}`);
    bytes = new Uint8Array(length);
    bytes.set(encoder.encode("TIL2"));
    new DataView(bytes.buffer).setUint32(4, features, true);
    let at = 8;
    for (const part of parts)
      for (const r of tileRecords(part)) {
        bytes.set(part.subarray(r.start, r.end), at);
        at += r.end - r.start;
      }
    const zipped = Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>);
    const stored: InputBlock =
      zipped.length < bytes.length
        ? {
            ...input,
            bytes: zipped,
            features,
            codec: "gzip",
            rawLength: bytes.length,
          }
        : { ...input, bytes, features };
    const block = await describeBlock(
      { ...stored, z: a.z, x: a.x, y: a.y },
      this.length,
    );
    if (RESERVE + this.length + stored.bytes.length > this.maxBytes)
      throw Error("Water patch exceeds output budget");
    this.db
      .query("INSERT INTO changed VALUES(?,?,?)")
      .run(
        block.key,
        pageKey(
          a.prefix,
          a.z,
          Math.floor(a.x / INDEX_PAGE_SIZE),
          Math.floor(a.y / INDEX_PAGE_SIZE),
        ),
        JSON.stringify(block),
      );
    await write(this.file, stored.bytes, RESERVE + this.length);
    this.length += stored.bytes.length;
    this.addedFeatures += features - (original?.features ?? 0);
  }
  async finish(manifest: Omit<Manifest, "snapshot">) {
    this.db.run("COMMIT");
    const pages: IndexPage[] = [],
      oldPages = new Set<string>();
    const changes = this.db.query<{ json: string }, [string]>(
      "SELECT json FROM changed WHERE page=? ORDER BY key",
    );
    const append = async (page: IndexPage, bytes: Uint8Array) => {
      this.signal.throwIfAborted();
      if (RESERVE + this.length + bytes.length > this.maxBytes)
        throw Error("Water patch exceeds output budget");
      pages.push({ ...page, offset: this.length });
      await write(this.file, bytes, RESERVE + this.length);
      this.length += bytes.length;
    };
    const leaf = async (key: string, blocks: Block[]) => {
      if (!blocks.length || blocks.length > INDEX_PAGE_SIZE ** 2)
        throw Error("Invalid water leaf size");
      blocks.sort((a, b) => a.offset - b.offset);
      const a = spatialAddress(blocks[0]!.key)!;
      const raw = encoder.encode(JSON.stringify(blocks)),
        bytes = Bun.gzipSync(raw);
      await append(
        {
          ...(await describeBlock(
            { key, bytes, codec: "gzip", rawLength: raw.length },
            0,
          )),
          z: a.z,
          x: Math.floor(a.x / INDEX_PAGE_SIZE),
          y: Math.floor(a.y / INDEX_PAGE_SIZE),
          prefix: a.prefix,
          count: blocks.length,
        },
        bytes,
      );
    };
    let copiedPages = 0;
    for (const p of this.reader.index.pages) {
      if (this.replacesObjects && p.prefix?.startsWith("objects/")) continue;
      if (++copiedPages % 1000 === 0)
        this.progress(
          `Packing directory: ${copiedPages}/${this.reader.index.pages.length} existing pages`,
        );
      oldPages.add(p.key);
      const replacements = changes
        .all(p.key)
        .map((r) => JSON.parse(r.json) as Block);
      if (!replacements.length) await append(p, await this.stored(p));
      else {
        const blocks = new Map((await this.entries(p)).map((b) => [b.key, b]));
        for (const b of replacements) blocks.set(b.key, b);
        await leaf(p.key, [...blocks.values()]);
      }
    }
    for (const { page } of this.db
      .query<
        { page: string },
        []
      >("SELECT DISTINCT page FROM changed ORDER BY page")
      .iterate())
      if (!oldPages.has(page))
        await leaf(
          page,
          changes.all(page).map((r) => JSON.parse(r.json)),
        );
    const prefix = await encodePrefix(
      { ...manifest, features: manifest.features + this.addedFeatures },
      [
        ...this.reader.index.blocks.filter(
          (b) => !this.replacesObjects || !b.key.startsWith("objects/"),
        ),
        ...this.objectRoots,
      ],
      this.length,
      pages,
    );
    const size = prefix.length + this.length;
    if (size > this.maxBytes) throw Error("Water patch exceeds output budget");
    const buffer = new Uint8Array(8 * 1024 ** 2);
    for (let at = 0; at < this.length; ) {
      this.signal.throwIfAborted();
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        Math.min(buffer.length, this.length - at),
        RESERVE + at,
      );
      if (!bytesRead) throw Error("Truncated water patch");
      await write(this.file, buffer.subarray(0, bytesRead), prefix.length + at);
      at += bytesRead;
      if (at % (256 * 1024 ** 2) === 0 || at === this.length)
        this.progress(`Finalizing archive: ${at}/${this.length} bytes`);
    }
    await write(this.file, prefix, 0);
    await this.file.truncate(size);
    await this.file.sync();
    await this.file.close();
    this.db.close();
    await rm(this.scratch, { recursive: true, force: true });
    await rename(this.output + ".part", this.output);
    this.ownsPart = false;
    return size;
  }
  async abort() {
    await this.file?.close().catch(() => {});
    try {
      this.db?.close();
    } catch {}
    if (this.ownsPart) await rm(this.output + ".part", { force: true });
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true });
  }
}
