import type {
  AtlasReader,
  ReadEvent,
} from "../../../../packages/format/src/reader";
export class ChatDataClient {
  private worker = new Worker("/chat-data-worker.js", { type: "module" });
  private sequence = 0;
  private jobs = new Map<
    number,
    {
      resolve(v: any): void;
      reject(e: Error): void;
      signal: AbortSignal;
      cleanup(): void;
      progress?: (message: string) => void;
    }
  >();
  private lifetime = new AbortController();
  sourceBytes = 0;
  constructor(
    readonly readers: AtlasReader[],
    readonly offline: () => boolean,
    readonly onTransfer?: (event: ReadEvent) => void,
  ) {
    this.worker.onmessage = ({ data: m }) => {
      if (m.type === "transfer") {
        this.sourceBytes += m.event.bytes;
        this.onTransfer?.(m.event);
        return;
      }
      if (m.type === "read") {
        void this.read(m);
        return;
      }
      const job = this.jobs.get(m.id);
      if (!job) return;
      if (m.type === "progress") {
        job.progress?.(m.message);
        return;
      }
      this.jobs.delete(m.id);
      job.cleanup();
      if (m.type === "error")
        job.reject(Object.assign(new Error(m.error), { code: m.code }));
      else job.resolve(m.value);
    };
    this.worker.onerror = () =>
      this.destroy("Map analysis worker failed. Reopen the chat.");
    this.worker.postMessage({
      type: "init",
      sources: readers.map((r) => ({
        index: r.index,
        store: !!r.options.store,
      })),
    });
  }
  private async read(m: any) {
    const reader = this.readers[m.source],
      job = this.jobs.get(m.job);
    try {
      if (!reader || !job) throw new Error("Map request expired");
      job.signal.throwIfAborted();
      let value: unknown;
      if (m.method === "range") {
        const [a, b] = m.args;
        if (this.offline()) throw new Error("Not cached: chat source bytes");
        if (
          ![a, b].every(Number.isSafeInteger) ||
          a < 0 ||
          b <= a ||
          b > reader.index.header.fileLength
        )
          throw new Error("Invalid map byte request");
        value = await reader.source.read(
          a,
          b,
          AbortSignal.any([job.signal, this.lifetime.signal]),
        );
      } else {
        const store = reader.options.store;
        if (!store) throw new Error("Persistent cache unavailable");
        const [snapshot, block, bytes] = m.args;
        if (snapshot !== reader.index.manifest.snapshot)
          throw new Error("Cache snapshot mismatch");
        if (m.method === "get") value = await store.get(snapshot, block);
        else if (m.method === "put") {
          job.signal.throwIfAborted();
          await store.put(snapshot, block, bytes);
        } else if (m.method === "keys") value = await store.keys(snapshot);
        else throw new Error("Unknown cache request");
      }
      if (!this.lifetime.signal.aborted)
        this.worker.postMessage({ type: "reply", id: m.id, value });
    } catch (e) {
      if (!this.lifetime.signal.aborted)
        this.worker.postMessage({
          type: "reply",
          id: m.id,
          error: e instanceof Error ? e.message : String(e),
        });
    }
  }
  call(
    name: string,
    input: unknown,
    signal: AbortSignal,
    progress?: (message: string) => void,
  ): Promise<any> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.worker.postMessage({ type: "cancel", id });
        this.jobs.delete(id);
        reject(new DOMException("Map operation cancelled", "AbortError"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.jobs.set(id, {
        resolve,
        reject,
        signal,
        progress,
        cleanup: () => signal.removeEventListener("abort", cancel),
      });
      this.worker.postMessage({
        type: "call",
        id,
        name,
        input,
        offline: this.offline(),
      });
    });
  }
  destroy(message = "Map session closed") {
    this.lifetime.abort();
    this.worker.terminate();
    for (const job of this.jobs.values()) {
      job.cleanup();
      job.reject(new Error(message));
    }
    this.jobs.clear();
  }
}
