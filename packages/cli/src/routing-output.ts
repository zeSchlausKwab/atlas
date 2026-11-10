import type { BlockWriter } from "./stream-writer";
import type { TransportMode } from "../../format/src/index";

const WINDOW_BYTES = 1024 * 1024;
const CELL_BYTES = 32 * 1024 * 1024;
/** Acknowledge only after every preceding archive write has completed. Runtime
 * pipe buffering cannot run ahead of this one-batch producer credit window. */
export async function consumeRoutingOutput(
  writer: BlockWriter,
  chunks: AsyncIterable<Uint8Array>,
  modes: readonly TransportMode[],
  federated: boolean,
  acknowledge: () => Promise<void>,
  signal = new AbortController().signal,
  truncated = async () => new Error("Truncated native compiler frame"),
) {
  const iterator = chunks[Symbol.asyncIterator]();
  let buffer: Uint8Array = new Uint8Array(0);
  let offset = 0,
    position = 0,
    lastKey = "start";
  async function take(n: number, eof = false): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      signal.throwIfAborted();
      if (offset === buffer.length) {
        const v = await iterator.next();
        if (v.done) {
          if (eof && at === 0) return null;
          throw await truncated();
        }
        buffer = v.value;
        offset = 0;
      }
      const len = Math.min(n - at, buffer.length - offset);
      out.set(buffer.subarray(offset, offset + len), at);
      offset += len;
      at += len;
      position += len;
    }
    return out;
  }
  let protocol = false,
    pending = 0,
    metadata: any;
  const decoder = new TextDecoder();
  while (true) {
    const header = await take(8, true);
    if (!header) break;
    const v = new DataView(header.buffer),
      kl = v.getUint32(0, true),
      len = v.getUint32(4, true);
    if (!kl || kl > 256 || len > CELL_BYTES)
      throw new Error(
        `Invalid routing output frame at byte ${position - 8} after ${lastKey}: key ${kl} bytes, payload ${len} bytes (maximum ${CELL_BYTES})`,
      );
    const key = decoder.decode((await take(kl))!);
    lastKey = key;
    if (!protocol && key !== "protocol")
      throw new Error(
        "Native routing compiler lacks acknowledged output; rebuild transport-partitioned",
      );
    if (
      (key === "protocol" && len > 1024) ||
      (key === "metadata" && len > 64 * 1024)
    )
      throw new Error(`Oversized routing ${key} frame`);
    const bytes = (await take(len))!;
    if (key === "protocol") {
      const p = JSON.parse(decoder.decode(bytes));
      if (protocol || p.version !== 1 || p.windowBytes !== WINDOW_BYTES)
        throw new Error("Unsupported routing output protocol");
      protocol = true;
      continue;
    }
    if (key === "ack") {
      if (len || !pending || metadata)
        throw new Error("Invalid routing output acknowledgment request");
      signal.throwIfAborted();
      await acknowledge();
      pending = 0;
      continue;
    }
    if (key === "metadata") {
      if (metadata || pending)
        throw new Error("Invalid routing output metadata order");
      metadata = JSON.parse(decoder.decode(bytes));
      continue;
    }
    const match =
      /^routing\/(walking|cycling|driving)\/cells\/14\/(\d+)\/(\d+)$/.exec(key);
    if (!match || metadata) throw new Error("Invalid native compiler frame");
    const size = 8 + kl + len;
    if (pending && pending + size > WINDOW_BYTES)
      throw new Error(
        "Native routing compiler exceeded its acknowledged output window",
      );
    if (
      len < 28 ||
      decoder.decode(bytes.subarray(0, 4)) !== (federated ? "RCL3" : "RCL2")
    )
      throw new Error(
        "Native routing codec does not match the requested contract",
      );
    pending += size;
    if (modes.includes(match[1] as TransportMode))
      await writer.add({
        key,
        bytes,
        features: new DataView(bytes.buffer).getUint32(24, true),
      });
  }
  if (!protocol || !metadata || pending) throw await truncated();
  return metadata;
}
