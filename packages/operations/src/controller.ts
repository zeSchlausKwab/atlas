import type { Operation, OperationInputs } from "./contract";
import type { RoutingProgress } from "../../routing/src/paged";
export interface OperationProgress {
  operation: Operation;
  requestId: number;
  progress: RoutingProgress;
}
const channel = (op: Operation) =>
  op === "route" || op === "isochrone" ? "transport" : op;
/** Latest request wins within a resource channel. Cancellation is scoped to the
 * requesting tool, so clearing an old route cannot kill an active isochrone. */
export class OperationController {
  private sequence = 0;
  private active = new Map<
    string,
    { operation: Operation; id: number; abort: AbortController }
  >();
  private listeners = new Set<(event: OperationProgress) => void>();
  subscribe(listener: (event: OperationProgress) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  cancel(operation?: Operation) {
    for (const [key, job] of this.active)
      if (!operation || job.operation === operation) {
        this.active.delete(key);
        job.abort.abort(new DOMException("Operation cancelled", "AbortError"));
      }
  }
  async run<K extends Operation, R>(
    operation: K,
    input: OperationInputs[K],
    execute: (
      input: OperationInputs[K],
      signal: AbortSignal,
      progress: (p: RoutingProgress) => void,
    ) => Promise<R>,
  ): Promise<R> {
    const key = channel(operation),
      previous = this.active.get(key);
    if (previous) this.cancel(previous.operation);
    const job = {
      operation,
      id: ++this.sequence,
      abort: new AbortController(),
    };
    this.active.set(key, job);
    const signal = job.abort.signal,
      snapshot = structuredClone(input);
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const progress = (value: RoutingProgress) => {
      if (this.active.get(key) !== job || signal.aborted) return;
      for (const listener of this.listeners)
        listener({ operation, requestId: job.id, progress: value });
    };
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return execute(snapshot, signal, progress);
        }),
        aborted,
      ]);
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", rejectAbort);
      if (this.active.get(key) === job) this.active.delete(key);
    }
  }
  destroy() {
    this.cancel();
    this.listeners.clear();
  }
}
