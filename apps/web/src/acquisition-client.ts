import type {
  AtlasReader,
  ReadEvent,
} from "../../../packages/format/src/reader";
import type { SavedAreaView } from "../../../packages/acquisition/src/browser";
/** One browser-side acquisition session shared by the UI and AI harness. */
export class BrowserAcquisition {
  private worker = new Worker("/acquisition-worker.js", { type: "module" });
  private seq = 0;
  private calls = new Map<
    number,
    {
      resolve(v: any): void;
      reject(e: Error): void;
      signal: AbortSignal;
      readAbort: AbortController;
      cleanup(): void;
      progress?: (text: string) => void;
    }
  >();
  private listeners = new Set<() => void>();
  jobs: SavedAreaView[] = [];
  busy = false;
  sourceBytes = 0;
  private lifetime = new AbortController();
  readonly sourceIds: string[];
  constructor(
    readonly readers: AtlasReader[],
    readonly offline: () => boolean,
    readonly transfer?: (event: ReadEvent) => void,
  ) {
    this.sourceIds = readers.map((r) => r.index.manifest.snapshot);
    this.worker.onmessage = ({ data: m }) => {
      if (m.type === "read") {
        void this.read(m);
        return;
      }
      if (m.type === "transfer") {
        this.sourceBytes += m.event.bytes;
        this.transfer?.(m.event);
        return;
      }
      if (m.type === "job") {
        this.jobs = [m.job, ...this.jobs.filter((j) => j.id !== m.job.id)];
        this.changed();
        for (const call of this.calls.values()) call.progress?.(m.job.message);
        return;
      }
      const call = this.calls.get(m.id);
      if (!call) return;
      this.calls.delete(m.id);
      call.cleanup();
      m.type === "error" ? call.reject(Error(m.error)) : call.resolve(m.value);
    };
    this.worker.onerror = (event) =>
      this.destroy(
        `Acquisition worker failed: ${event.message || "could not load worker"}. Reload the map to resume saved blocks.`,
      );
    this.worker.postMessage({
      type: "init",
      sources: readers.map((r, i) => ({
        id: this.sourceIds[i],
        index: r.index,
      })),
    });
    void this.refresh().catch(() => {});
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private changed() {
    for (const f of this.listeners) f();
  }
  private async read(m: any) {
    try {
      const call = this.calls.get(m.job),
        reader = this.readers[m.source];
      if (!call || !reader) throw Error("Acquisition request expired");
      if (this.offline()) throw Error("Not cached: acquisition source bytes");
      if (
        ![m.start, m.end].every(Number.isSafeInteger) ||
        m.start < 0 ||
        m.end <= m.start ||
        m.end > reader.index.header.fileLength
      )
        throw Error("Invalid source range");
      const value = await reader.source.read(
        m.start,
        m.end,
        AbortSignal.any([
          call.signal,
          call.readAbort.signal,
          this.lifetime.signal,
        ]),
      );
      if (!this.lifetime.signal.aborted)
        this.worker.postMessage({ type: "reply", id: m.id, value });
    } catch (e) {
      if (!this.lifetime.signal.aborted)
        this.worker.postMessage({ type: "reply", id: m.id, error: String(e) });
    }
  }
  async call(
    action: string,
    input: unknown = {},
    signal = new AbortController().signal,
    progress?: (text: string) => void,
  ): Promise<any> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const mutation = !["list", "catalog"].includes(action);
    if (mutation && this.busy)
      throw Error("Pause the current acquisition before starting another.");
    if (mutation) {
      this.busy = true;
      this.changed();
    }
    try {
      const value = await new Promise<any>((resolve, reject) => {
        const id = ++this.seq;
        const readAbort = new AbortController();
        const cancel = () => {
          readAbort.abort();
          this.worker.postMessage({ type: "cancel", id });
        };
        signal.addEventListener("abort", cancel, { once: true });
        this.calls.set(id, {
          resolve,
          reject,
          signal,
          readAbort,
          progress,
          cleanup: () => signal.removeEventListener("abort", cancel),
        });
        this.worker.postMessage({
          type: "call",
          id,
          action,
          input,
          offline: this.offline(),
        });
      });
      if (action === "remove")
        this.jobs = this.jobs.filter((j) => j.id !== (input as any).id);
      return value;
    } finally {
      if (mutation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  pause() {
    for (const [id, call] of this.calls) {
      call.readAbort.abort();
      this.worker.postMessage({ type: "cancel", id });
    }
  }
  async refresh() {
    this.jobs = await this.call("list");
    this.changed();
  }
  destroy(
    message = "Map selection changed. Saved acquisitions can be resumed with the original revisions.",
  ) {
    this.lifetime.abort();
    this.worker.terminate();
    for (const c of this.calls.values()) {
      c.cleanup();
      c.reject(Error(message));
    }
    this.calls.clear();
    this.listeners.clear();
  }
}
