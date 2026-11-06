import type { BlockWriter } from "../../cli/src/stream-writer";
import { PACK_BYTES, CHUNK_BYTES, type PayloadRef } from "./model";
/** At most 128 spatially grouped buffers (8 MiB); references stay stable before flush. */
export class PayloadPacker {
  private buffers = new Map<
    string,
    { key: string; bytes: Uint8Array; used: number }
  >();
  constructor(
    private writer: BlockWriter,
    private next: (kind: string) => string,
  ) {}
  async add(kind: string, bytes: Uint8Array, group = ""): Promise<PayloadRef> {
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
    const slot = kind + ":" + group;
    let buffer = this.buffers.get(slot);
    if (buffer && buffer.used + bytes.length > PACK_BYTES) {
      await this.flush(slot);
      buffer = undefined;
    }
    if (!buffer) {
      if (this.buffers.size >= 128)
        await this.flush(this.buffers.keys().next().value!);
      buffer = {
        key: this.next(kind),
        bytes: new Uint8Array(PACK_BYTES),
        used: 0,
      };
      this.buffers.set(slot, buffer);
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
