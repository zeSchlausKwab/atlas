import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import {
  describeBlock,
  encodePagedIndex,
  type InputBlock,
} from "../../format/src/writer";
import type { Block, Manifest } from "../../format/src/index";
async function writeAll(file: FileHandle, bytes: Uint8Array) {
  for (let n = 0; n < bytes.length; )
    n += (await file.write(bytes, n, bytes.length - n)).bytesWritten;
}
/** Keep only the directory in memory; publish by atomic rename after the budget check. */
export class DiskWriter {
  readonly blocks: Block[] = [];
  private length = 0;
  private spool!: FileHandle;
  private keys = new Set<string>();
  constructor(
    readonly output: string,
    readonly maxBytes: number,
  ) {}
  async open() {
    this.spool = await open(`${this.output}.payload.part`, "w");
    return this;
  }
  async add(input: InputBlock) {
    if (this.keys.has(input.key))
      throw new Error(`Duplicate block ${input.key}`);
    this.keys.add(input.key);
    const zipped = input.codec
      ? input.bytes
      : Bun.gzipSync(input.bytes as Uint8Array<ArrayBuffer>);
    const stored: InputBlock =
      zipped.length < input.bytes.length
        ? {
            ...input,
            bytes: zipped,
            codec: "gzip",
            rawLength: input.bytes.length,
          }
        : input;
    if (this.length + stored.bytes.length > this.maxBytes)
      throw new Error("Package exceeds --max-bytes budget");
    this.blocks.push(await describeBlock(stored, this.length));
    await writeAll(this.spool, stored.bytes);
    this.length += stored.bytes.length;
  }
  async finish(manifest: Omit<Manifest, "snapshot">) {
    await this.spool.close();
    const { prefix, pages } = await encodePagedIndex(
      manifest,
      this.blocks,
      this.length,
    );
    const size =
      prefix.length + this.length + pages.reduce((n, p) => n + p.length, 0);
    if (size > this.maxBytes)
      throw new Error("Package exceeds --max-bytes budget");
    const file = await open(`${this.output}.part`, "w");
    try {
      await writeAll(file, prefix);
      for await (const chunk of createReadStream(`${this.output}.payload.part`))
        await writeAll(file, chunk);
      for (const page of pages) await writeAll(file, page);
    } finally {
      await file.close();
    }
    await rename(`${this.output}.part`, this.output);
    await rm(`${this.output}.payload.part`);
    return size;
  }
}
