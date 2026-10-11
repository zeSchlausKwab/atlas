import { fileURLToPath } from "node:url";
/** At most `concurrency` inputs/results are resident. Results commit in input order.
 * Children own their SQLite files. Await their exit before callers remove scratch.
 */
export async function* parallelMap<T, R>(
  script: URL,
  inputs: AsyncIterable<T> | Iterable<T>,
  concurrency: number,
  signal?: AbortSignal,
  onProgress?: (index: number, value: any) => void,
  scratchDirectory?: string,
): AsyncGenerator<{ input: T; result: R }> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Invalid compiler concurrency");
  signal?.throwIfAborted();
  type Outcome =
    | { result: R; error?: never }
    | { error: Error; result?: never };
  type Slot = {
    child: Bun.Subprocess;
    settle?: (value: Outcome) => void;
    index: number;
    closed: boolean;
  };
  const slots: Slot[] = [];
  let closing = false,
    failure: Error | undefined;
  function fail(error: Error) {
    failure ??= error;
    for (const slot of slots) {
      slot.settle?.({ error: failure });
      slot.settle = undefined;
      slot.child.kill("SIGKILL");
    }
  }
  const abort = () =>
    fail(
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("Compilation cancelled"),
    );
  signal?.addEventListener("abort", abort, { once: true });
  const iterator = (async function* () {
    yield* inputs;
  })();
  let index = 0;
  const pending: { input: T; promise: Promise<Outcome> }[] = [];
  try {
    const schedule = async () => {
      if (failure) throw failure;
      signal?.throwIfAborted();
      const next = await iterator.next();
      if (failure) throw failure;
      signal?.throwIfAborted();
      if (next.done) return false;
      let slot = slots.find((s) => !s.settle && !s.closed);
      if (!slot) {
        slot = { child: undefined as any, index: -1, closed: false };
        const current = slot;
        current.child = Bun.spawn([process.execPath, fileURLToPath(script)], {
          env: scratchDirectory
            ? {
                ...process.env,
                SQLITE_TMPDIR: scratchDirectory,
                TMPDIR: scratchDirectory,
              }
            : process.env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          serialization: "json",
          ipc(message) {
            const m = message as { type: string; value: any };
            if (!current.settle) return;
            if (m.type === "progress") {
              try {
                onProgress?.(current.index, m.value);
              } catch (e) {
                fail(e as Error);
              }
            } else if (m.type === "result") {
              current.settle({ result: m.value });
              current.settle = undefined;
            } else if (m.type === "error")
              fail(new Error(`Compiler worker: ${m.value}`));
          },
          onExit(_proc, code, _signal, error) {
            current.closed = true;
            if (!closing)
              fail(
                error ??
                  new Error(`Compiler worker exited unexpectedly (${code})`),
              );
          },
        });
        slots.push(current);
      }
      slot.index = index++;
      const promise = new Promise<Outcome>((resolve) => {
        slot!.settle = resolve;
      });
      pending.push({ input: next.value, promise });
      slot.child.send(next.value);
      return true;
    };
    while (pending.length < concurrency && (await schedule())) {}
    while (pending.length) {
      const entry = pending.shift()!;
      const outcome = await entry.promise;
      if (outcome.error) throw outcome.error;
      if (failure) throw failure;
      signal?.throwIfAborted();
      yield { input: entry.input, result: outcome.result as R };
      await schedule();
    }
  } finally {
    closing = true;
    signal?.removeEventListener("abort", abort);
    for (const slot of slots) slot.child.kill("SIGKILL");
    await Promise.all(slots.map((s) => s.child.exited));
    await iterator.return(undefined);
  }
}

/** Install a persistent worker. A disconnected parent must not leave an orphan compiler. */
export function serveWorker<T, R>(
  run: (input: T, report: (value: any) => void) => Promise<R>,
) {
  let busy = false;
  process.on("disconnect", () => process.exit(0));
  process.on("message", async (input: T) => {
    if (busy) {
      process.send?.({ type: "error", value: "Concurrent task on one worker" });
      return;
    }
    busy = true;
    try {
      process.send?.({
        type: "result",
        value: await run(input, (value) =>
          process.send?.({ type: "progress", value }),
        ),
      });
    } catch (error) {
      process.send?.({ type: "error", value: String(error) });
    } finally {
      busy = false;
    }
  });
}
