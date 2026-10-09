import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { ByteSource } from "../../packages/format/src/reader";
/** A pinned inode: atomic path replacement does not change this server's snapshot. */
export class PackageSource implements ByteSource {
  private closed = false;
  private constructor(
    private handle: FileHandle,
    private original: BigIntStats,
    readonly etag: string,
  ) {}
  get size() {
    return Number(this.original.size);
  }
  static async open(path: string) {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Invalid package file");
      const source = new PackageSource(handle, stat, "");
      const hash = createHash("sha256"),
        chunkSize = 1024 * 1024;
      for (let start = 0; start < source.size; start += chunkSize)
        hash.update(
          await source.read(start, Math.min(source.size, start + chunkSize)),
        );
      await source.assertUnchanged();
      return new PackageSource(handle, stat, `"${hash.digest("hex")}"`);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async assertUnchanged() {
    if (this.closed) throw new Error("Package source closed");
    const stat = await this.handle.stat({ bigint: true });
    if (
      stat.size !== this.original.size ||
      stat.mtimeNs !== this.original.mtimeNs
    )
      throw new Error(
        "Package was modified in place; restart the server. Publish updates by atomic rename.",
      );
  }
  async read(start: number, end: number) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.size
    )
      throw new Error("Invalid package range");
    await this.assertUnchanged();
    const bytes = new Uint8Array(end - start);
    let at = 0;
    while (at < bytes.length) {
      const { bytesRead } = await this.handle.read(
        bytes,
        at,
        bytes.length - at,
        start + at,
      );
      if (!bytesRead) throw new Error("Truncated package file");
      at += bytesRead;
    }
    await this.assertUnchanged();
    return bytes;
  }
  slice(start = 0, end = this.size) {
    let at = start;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            if (at >= end) {
              controller.close();
              return;
            }
            const next = Math.min(end, at + 64 * 1024);
            controller.enqueue(await this.read(at, next));
            at = next;
          } catch (error) {
            controller.error(error);
          }
        },
      },
      { highWaterMark: 1 },
    );
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close();
    }
  }
}
