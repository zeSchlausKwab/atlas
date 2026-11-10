import { Database } from "bun:sqlite";
import { open, rm, type FileHandle } from "node:fs/promises";
import type { InputBlock } from "../../format/src/writer";
import type { BlockWriter } from "../../cli/src/stream-writer";

/** One sequential compressed payload on the workspace volume; transactional indexes stay local.
 * File bytes reach disk before their SQLite checkpoint. Uncommitted tails are truncated on reopen.
 * Final .atlas assembly is disposable and can be repeated from this store without reprocessing OSM.
 */
export class ObjectStaging implements BlockWriter {
  db!: Database;
  private file!: FileHandle;
  private length = 0;
  private count = 0;
  private closed = false;
  state: any;
  constructor(
    readonly indexPath: string,
    readonly payloadPath: string,
    readonly identity: string,
  ) {}
  get payloadBytes() {
    return this.length;
  }
  async open() {
    this.db = new Database(this.indexPath);
    this.db
      .run(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384;
      CREATE TABLE IF NOT EXISTS stage_state(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stage_blocks(seq INTEGER PRIMARY KEY, key TEXT UNIQUE, metadata TEXT, offset INTEGER, length INTEGER, hash TEXT);`);
    const saved = this.db
      .query<{ json: string }, []>("SELECT json FROM stage_state WHERE id=1")
      .get();
    if (saved) {
      const checkpoint = JSON.parse(saved.json);
      if (checkpoint.version !== 1 || checkpoint.identity !== this.identity) {
        this.db.close();
        throw new Error("Source-object checkpoint identity mismatch");
      }
      this.length = checkpoint.length;
      this.count = checkpoint.count;
      this.state = checkpoint.state;
      this.file = await open(this.payloadPath, "r+");
      if ((await this.file.stat()).size < this.length) {
        await this.file.close();
        this.db.close();
        throw new Error("Source-object checkpoint payload is truncated");
      }
      await this.file.truncate(this.length);
    } else {
      this.file = await open(this.payloadPath, "w+");
    }
    this.db.run("BEGIN");
    return this;
  }
  async add(input: InputBlock) {
    const compressed = input.codec
      ? input.bytes
      : Bun.gzipSync(input.bytes as Uint8Array<ArrayBuffer>);
    const bytes =
      compressed.length < input.bytes.length ? compressed : input.bytes;
    const { bytes: _, ...metadata } = input;
    const stored =
      bytes === input.bytes
        ? metadata
        : { ...metadata, codec: "gzip", rawLength: input.bytes.length };
    let written = 0;
    while (written < bytes.length) {
      const n = (
        await this.file.write(
          bytes,
          written,
          bytes.length - written,
          this.length + written,
        )
      ).bytesWritten;
      if (!n) throw new Error("Source-object payload write made no progress");
      written += n;
    }
    this.db
      .query("INSERT INTO stage_blocks VALUES(?,?,?,?,?,?)")
      .run(
        ++this.count,
        input.key,
        JSON.stringify(stored),
        this.length,
        bytes.length,
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      );
    this.length += bytes.length;
  }
  async checkpoint(state: unknown) {
    await this.file.sync();
    this.db
      .query("INSERT OR REPLACE INTO stage_state VALUES(1,?)")
      .run(
        JSON.stringify({
          version: 1,
          identity: this.identity,
          length: this.length,
          count: this.count,
          state,
        }),
      );
    this.db.run("COMMIT; BEGIN");
    this.state = state;
  }
  async copyTo(
    writer: BlockWriter,
    signal?: AbortSignal,
    progress: (done: number, total: number) => void = () => {},
  ) {
    progress(0, this.count);
    for (const row of this.db
      .query<
        {
          seq: number;
          metadata: string;
          offset: number;
          length: number;
          hash: string;
        },
        []
      >("SELECT seq,metadata,offset,length,hash FROM stage_blocks ORDER BY seq")
      .iterate()) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(row.length);
      for (let n = 0; n < bytes.length; ) {
        const got = (
          await this.file.read(bytes, n, bytes.length - n, row.offset + n)
        ).bytesRead;
        if (!got)
          throw new Error("Source-object checkpoint payload is truncated");
        n += got;
      }
      if (
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== row.hash
      )
        throw new Error("Source-object checkpoint block checksum mismatch");
      await writer.add({ ...JSON.parse(row.metadata), bytes });
      progress(row.seq, this.count);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db?.run("ROLLBACK");
    } finally {
      this.db?.close();
      await this.file?.close();
    }
  }
  async remove() {
    await this.close();
    await rm(this.indexPath, { force: true });
    await rm(this.indexPath + "-journal", { force: true });
    await rm(this.payloadPath, { force: true });
  }
}
