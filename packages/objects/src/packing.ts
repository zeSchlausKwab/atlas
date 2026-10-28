import type { BlockWriter } from "../../cli/src/stream-writer";
import { PACK_BYTES, CHUNK_BYTES, type PayloadRef } from "./model";
/** Two bounded buffers; references are stable before the buffers are flushed. */
export class PayloadPacker {
  private buffers = new Map<
    string,
    { key: string; bytes: Uint8Array; used: number }
  >();
  constructor(
    private writer: BlockWriter,
    private next: (kind: string) => string,
  ) {}
  async add(kind: string, bytes: Uint8Array): Promise<PayloadRef> {
    if (bytes.length > PACK_BYTES) {
      const blocks: string[] = [];
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
        const key = this.next(kind);
        await this.writer.add({
          key,
          bytes: bytes.slice(at, at + CHUNK_BYTES),
        });
        blocks.push(key);
      }
      return { blocks, bytes: bytes.length };
    }
    let buffer = this.buffers.get(kind);
    if (buffer && buffer.used + bytes.length > PACK_BYTES) {
      await this.flush(kind);
      buffer = undefined;
    }
    if (!buffer) {
      buffer = {
        key: this.next(kind),
        bytes: new Uint8Array(PACK_BYTES),
        used: 0,
      };
      this.buffers.set(kind, buffer);
    }
    const offset = buffer.used;
    buffer.bytes.set(bytes, offset);
    buffer.used += bytes.length;
    return { blocks: [buffer.key], offset, bytes: bytes.length };
  }
  private async flush(kind: string) {
    const buffer = this.buffers.get(kind);
    if (!buffer) return;
    await this.writer.add({
      key: buffer.key,
      bytes: buffer.bytes.slice(0, buffer.used),
    });
    this.buffers.delete(kind);
  }
  async finish() {
    for (const kind of [...this.buffers.keys()]) await this.flush(kind);
  }
}
