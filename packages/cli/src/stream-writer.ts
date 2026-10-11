import { Database } from "bun:sqlite";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import {
  describeBlock,
  encodePrefix,
  type InputBlock,
} from "../../format/src/writer";
import {
  MAX_METADATA,
  HEADER_SIZE,
  INDEX_PAGE_SIZE,
  spatialAddress,
  pageKey,
  type Block,
  type IndexPage,
  type Manifest,
} from "../../format/src/index";
export interface BlockWriter {
  add(input: InputBlock): Promise<void>;
}
const RESERVE = MAX_METADATA + HEADER_SIZE;
async function writeAll(file: FileHandle, bytes: Uint8Array, at: number) {
  for (let n = 0; n < bytes.length; ) {
    const written = (await file.write(bytes, n, bytes.length - n, at + n))
      .bytesWritten;
    if (!written) throw new Error("Archive write made no progress");
    n += written;
  }
}
/** The payload and directory are disk-backed. Only one bounded directory leaf is assembled at a time. */
export class StreamWriter implements BlockWriter {
  private db!: Database;
  private file!: FileHandle;
  private length = 0;
  private count = 0;
  constructor(
    readonly output: string,
    readonly maxBytes: number,
  ) {}
  get bytesWritten() {
    return this.length;
  }
  featureCount(prefix: string) {
    return this.db
      .query<
        { n: number },
        [string]
      >("SELECT coalesce(sum(json_extract(metadata,'$.features')),0) AS n FROM blocks WHERE key LIKE ?")
      .get(prefix + "%")!.n;
  }
  get blockCount() {
    return this.count;
  }
  async open() {
    await rm(this.output + ".directory.part", { force: true });
    this.db = new Database(this.output + ".directory.part");
    this.db
      .run(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384;
      CREATE TABLE blocks(key TEXT PRIMARY KEY, page TEXT NOT NULL, metadata TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX by_page ON blocks(page,key); BEGIN;`);
    this.file = await open(this.output + ".payload.part", "w+");
    return this;
  }
  async add(input: InputBlock) {
    const zipped = input.codec
      ? input.bytes
      : Bun.gzipSync(input.bytes as Uint8Array<ArrayBuffer>);
    const stored =
      zipped.length < input.bytes.length
        ? {
            ...input,
            bytes: zipped,
            codec: "gzip" as const,
            rawLength: input.bytes.length,
          }
        : input;
    if (this.length + stored.bytes.length > this.maxBytes)
      throw new Error("Package exceeds output budget");
    const a = spatialAddress(input.key);
    const b = await describeBlock(
      a && input.key.startsWith("tile/")
        ? { ...stored, z: a.z, x: a.x, y: a.y }
        : stored,
      this.length,
    );
    const page = a
      ? pageKey(
          a.prefix,
          a.z,
          Math.floor(a.x / INDEX_PAGE_SIZE),
          Math.floor(a.y / INDEX_PAGE_SIZE),
        )
      : "";
    this.db
      .query("INSERT INTO blocks VALUES(?,?,?)")
      .run(b.key, page, JSON.stringify(b));
    await writeAll(this.file, stored.bytes, RESERVE + this.length);
    this.length += stored.bytes.length;
    if (++this.count % 10000 === 0) this.db.run("COMMIT; BEGIN;");
  }
  async finish(
    manifest: Omit<Manifest, "snapshot">,
    beforeCopy?: (bytes: number) => Promise<void>,
    progress?: (
      stage: "directory" | "payload",
      completed: number,
      total: number,
    ) => void,
  ) {
    this.db.run("COMMIT");
    const pages: IndexPage[] = [],
      root: Block[] = [];
    for (const row of this.db
      .query<
        { metadata: string },
        []
      >("SELECT metadata FROM blocks WHERE page='' ORDER BY key")
      .iterate()) {
      root.push(JSON.parse(row.metadata));
      if (root.length > 100000)
        throw new Error("Too many unpaged archive records");
    }
    const groups = this.db.query<{ page: string }, []>(
      "SELECT DISTINCT page FROM blocks WHERE page<>'' ORDER BY page",
    );
    const pageTotal = progress
      ? this.db
          .query<
            { n: number },
            []
          >("SELECT count(DISTINCT page) AS n FROM blocks WHERE page<>''")
          .get()!.n
      : 0;
    progress?.("directory", 0, pageTotal);
    for (const { page } of groups.iterate()) {
      const blocks: Block[] = [];
      for (const row of this.db
        .query<
          { metadata: string },
          [string]
        >("SELECT metadata FROM blocks WHERE page=? ORDER BY key")
        .iterate(page)) {
        blocks.push(JSON.parse(row.metadata));
        if (blocks.length > INDEX_PAGE_SIZE ** 2)
          throw new Error("Directory leaf exceeds its grid");
      }
      blocks.sort((a, b) => a.offset - b.offset);
      const a = spatialAddress(blocks[0]!.key)!;
      const raw = new TextEncoder().encode(JSON.stringify(blocks));
      const bytes = Bun.gzipSync(raw);
      pages.push({
        ...(await describeBlock(
          { key: page, bytes, codec: "gzip", rawLength: raw.length },
          this.length,
        )),
        z: a.z,
        x: Math.floor(a.x / INDEX_PAGE_SIZE),
        y: Math.floor(a.y / INDEX_PAGE_SIZE),
        count: blocks.length,
        prefix: a.prefix,
      });
      await writeAll(this.file, bytes, RESERVE + this.length);
      this.length += bytes.length;
      progress?.("directory", pages.length, pageTotal);
      // Current format root has a 64 MiB encoded cap. Fail before unbounded descriptor growth.
      if (pages.length > 180000 || this.length > this.maxBytes)
        throw new Error("Archive directory/output budget exceeded");
    }
    root.sort((a, b) => a.offset - b.offset);
    const prefix = await encodePrefix(manifest, root, this.length, pages);
    const size = prefix.length + this.length;
    if (size > this.maxBytes) throw new Error("Package exceeds output budget");
    await beforeCopy?.(size);
    if (prefix.length > RESERVE)
      throw new Error("Archive metadata exceeds reserved prefix");
    // Move the payload left in bounded forward chunks. The destination is always
    // behind the next unread source byte, so overlapping ranges cannot corrupt it.
    // This needs no second full archive's worth of free disk space.
    progress?.("payload", 0, this.length);
    const chunk = new Uint8Array(4 * 1024 * 1024);
    for (let offset = 0; offset < this.length; ) {
      const length = Math.min(chunk.length, this.length - offset);
      const { bytesRead } = await this.file.read(
        chunk,
        0,
        length,
        RESERVE + offset,
      );
      if (!bytesRead) throw new Error("Archive payload is truncated");
      await writeAll(
        this.file,
        chunk.subarray(0, bytesRead),
        prefix.length + offset,
      );
      offset += bytesRead;
      progress?.("payload", offset, this.length);
    }
    await writeAll(this.file, prefix, 0);
    await this.file.truncate(size);
    await this.file.sync();
    await this.file.close();
    await rename(this.output + ".payload.part", this.output);
    this.db.close();
    await rm(this.output + ".directory.part");
    return size;
  }
  async abort() {
    await this.file?.close().catch(() => {});
    this.db?.close();
    for (const suffix of [".part", ".payload.part", ".directory.part"])
      await rm(this.output + suffix, { force: true });
  }
}
