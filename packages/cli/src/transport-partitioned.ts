import {
  validateRoutingFederation,
  type RoutingFederation,
} from "../../format/src/routing-contract";
import { consumeRoutingOutput } from "./routing-output";
import { spawn } from "node:child_process";
import { nativeDiagnostics } from "./native-diagnostics";
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
  sourceHash = "",
  federation?: RoutingFederation,
): Promise<TransportMetadata> {
  signal.throwIfAborted();
  if (federation) validateRoutingFederation(federation);
  const child = spawn(
    `${ROOT}/target/release/transport-partitioned`,
    [input, work],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TMPDIR: work,
        ATLAS_GRAPH_SOURCE_HASH: sourceHash,
        ATLAS_GRAPH_OUTPUT_ACK: "1",
        ATLAS_ROUTING_IDS: federation?.segmentIdentity ?? "legacy",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
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
  const diagnostics = nativeDiagnostics(child, progress);
  const { exited, stderr } = diagnostics;
  // Pipe errors are reported by the awaited write callback, including cancellation.
  child.stdin!.on("error", () => {});
  try {
    const metadata = await consumeRoutingOutput(
      writer,
      child.stdout!,
      modes,
      !!federation,
      () =>
        new Promise<void>((resolve, reject) => {
          child.stdin!.write(Uint8Array.of(1), (error) =>
            error ? reject(error) : resolve(),
          );
        }),
      signal,
      async () => {
        const exit = await exited;
        signal.throwIfAborted();
        return exit.code !== 0
          ? await diagnostics.failure("Partitioned graph compiler")
          : new Error("Truncated native compiler frame");
      },
    );
    const [{ code }] = await Promise.all([exited, stderr]);
    signal.throwIfAborted();
    if (code !== 0 || !metadata)
      throw await diagnostics.failure("Partitioned graph compiler");
    if (federation && modes.some((mode) => metadata[mode].skippedWays))
      throw new Error(
        "Incomplete routing source: missing way coordinates prevent federation",
      );
    return {
      version: 1,
      statistics: "cell-records",
      ...(federation ? { federation } : {}),
      profiles: Object.fromEntries(
        modes.map((mode) => [
          mode,
          {
            ...metadata[mode],
            prefix: `routing/${mode}/cells`,
            zoom: 14,
            codec: federation ? "rcl3" : "rcl2",
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
