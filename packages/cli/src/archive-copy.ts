import { Database } from "bun:sqlite";
import type { Block } from "../../format/src/index";
import { open, rm, type FileHandle } from "node:fs/promises";
import { AtlasReader, type ByteSource } from "../../format/src/reader";
import type { StreamWriter } from "./stream-writer";

/** A bounded read-ahead window over one open descriptor. Directory and payload
 * use separate windows so directory lookups cannot evict sequential map data. */
class ReadAhead implements ByteSource {
  private start = -1;
  private bytes = new Uint8Array(0);
  calls = 0;
  readBytes = 0;
  constructor(
    private file: FileHandle,
    private size: number,
    private window: number,
  ) {}
  async read(start: number, end: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.size
    )
      throw new Error("Invalid archive copy range");
    if (start >= this.start && end <= this.start + this.bytes.length)
      return this.bytes.subarray(start - this.start, end - this.start);
    const length = Math.min(
      this.size - start,
      Math.max(end - start, this.window),
    );
    const bytes = new Uint8Array(length);
    for (let done = 0; done < length; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await this.file.read(
        bytes,
        done,
        length - done,
        start + done,
      );
      this.calls++;
      this.readBytes += bytesRead;
      if (!bytesRead) throw new Error("Truncated archive during assembly");
      done += bytesRead;
    }
    this.start = start;
    this.bytes = bytes;
    return bytes.subarray(0, end - start);
  }
}

/** Copy immutable stored representations, keeping original codecs and hashes.
 * No decompression/recompression, no full archive or descriptor list in RAM. */
export async function copyArchiveBlocks(
  path: string,
  writer: StreamWriter,
  signal: AbortSignal,
  progress: (bytes: number) => void = () => {},
) {
  const file = await open(path, "r");
  let reader: AtlasReader | undefined;
  let order: Database | undefined;
  const orderPath = writer.directoryPath + ".copy";
  try {
    const before = await file.stat();
    const directory = new ReadAhead(file, before.size, 256 * 1024);
    const payload = new ReadAhead(file, before.size, 4 * 1024 ** 2);
    reader = await new AtlasReader(directory).open();
    // Directory traversal is by key, not physical offset. Sort descriptors on
    // the working disk so read-ahead never turns random lookups into huge reads.
    await rm(orderPath, { force: true });
    order = new Database(orderPath);
    order.run(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; CREATE TABLE blocks (offset INTEGER PRIMARY KEY, metadata TEXT); BEGIN;",
    );
    const insert = order.query("INSERT INTO blocks VALUES (?,?)");
    for await (const block of reader.iterateBlocks()) {
      signal.throwIfAborted();
      insert.run(block.offset, JSON.stringify(block));
    }
    order.run("COMMIT");
    let bytes = 0,
      blocks = 0;
    for (const row of order
      .query<
        { metadata: string },
        []
      >("SELECT metadata FROM blocks ORDER BY offset")
      .iterate()) {
      const block = JSON.parse(row.metadata) as Block;
      signal.throwIfAborted();
      const start = reader.index.header.payloadOffset + block.offset;
      const stored = await payload.read(start, start + block.length, signal);
      await writer.add(
        { ...block, bytes: stored },
        { compress: false, expectedHash: block.hash },
      );
      bytes += block.length;
      blocks++;
      progress(bytes);
    }
    signal.throwIfAborted();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Source archive changed during assembly");
    return {
      manifest: reader.index.manifest,
      bytes,
      blocks,
      readCalls: directory.calls + payload.calls,
      readBytes: directory.readBytes + payload.readBytes,
    };
  } finally {
    reader?.dispose();
    order?.close();
    await rm(orderPath, { force: true });
    await file.close();
  }
}
