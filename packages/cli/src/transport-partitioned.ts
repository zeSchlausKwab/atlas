import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BlockWriter } from "./stream-writer";
import {
  TRANSPORT_MODES,
  type TransportMetadata,
  type TransportMode,
} from "../../format/src/index";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Consume a native framed stream with backpressure; neither side buffers the full graph. */
export async function addPartitionedTransport(
  writer: BlockWriter,
  input: string,
  work: string,
  modes: readonly TransportMode[] = TRANSPORT_MODES,
  signal = new AbortController().signal,
  progress: (message: string) => void = console.log,
): Promise<TransportMetadata> {
  signal.throwIfAborted();
  const child = spawn(
    `${ROOT}/target/release/transport-partitioned`,
    [input, work],
    {
      cwd: ROOT,
      env: { ...process.env, TMPDIR: work },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const kill = () => {
    try {
      if (child.pid && process.platform !== "win32")
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
  };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  let tail = "";
  const stderr = (async () => {
    let pending = "";
    for await (const c of child.stderr!) {
      pending += c.toString();
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? "";
      for (const line of lines)
        if (line) {
          tail = line;
          progress(line);
        }
    }
  })();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  // Attach a handler immediately even when a pipe fails before exit is awaited.
  void exited.catch(() => {});
  const iterator = child.stdout![Symbol.asyncIterator]();
  let buffer = new Uint8Array(0),
    offset = 0;
  async function take(n: number, eof = false): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      signal.throwIfAborted();
      if (offset === buffer.length) {
        const v = await iterator.next();
        if (v.done) {
          if (eof && at === 0) return null;
          throw new Error("Truncated native compiler frame");
        }
        buffer = v.value;
        offset = 0;
      }
      const len = Math.min(n - at, buffer.length - offset);
      out.set(buffer.subarray(offset, offset + len), at);
      offset += len;
      at += len;
    }
    return out;
  }
  let metadata: any;
  try {
    while (true) {
      const header = await take(8, true);
      if (!header) break;
      const v = new DataView(header.buffer),
        kl = v.getUint32(0, true),
        len = v.getUint32(4, true);
      if (kl > 256 || len > 32 * 1024 * 1024)
        throw new Error("Native compiler frame exceeds cell budget");
      const key = new TextDecoder().decode((await take(kl))!);
      const bytes = (await take(len))!;
      if (key === "metadata") {
        if (metadata) throw new Error("Duplicate compiler metadata");
        metadata = JSON.parse(new TextDecoder().decode(bytes));
        continue;
      }
      const match =
        /^routing\/(walking|cycling|driving)\/cells\/14\/(\d+)\/(\d+)$/.exec(
          key,
        );
      if (!match || metadata) throw new Error("Invalid native compiler frame");
      if (modes.includes(match[1] as TransportMode))
        await writer.add({
          key,
          bytes,
          features: new DataView(bytes.buffer).getUint32(24, true),
        });
    }
    const [code] = await Promise.all([exited, stderr]);
    signal.throwIfAborted();
    if (code !== 0 || !metadata)
      throw new Error(`Partitioned graph compiler failed (${code}): ${tail}`);
    return {
      version: 1,
      statistics: "cell-records",
      profiles: Object.fromEntries(
        modes.map((mode) => [
          mode,
          {
            ...metadata[mode],
            prefix: `routing/${mode}/cells`,
            zoom: 14,
            codec: "rcl2",
          },
        ]),
      ),
    };
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
    await stderr.catch(() => {});
  }
}
