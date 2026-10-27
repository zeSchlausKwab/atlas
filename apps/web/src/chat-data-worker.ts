import { AtlasReader } from "../../../packages/format/src/reader";
import type { BlockStore } from "../../../packages/format/src/store";
import { ChatDataRuntime } from "../../../packages/chat/src/data";
let sequence = 0,
  currentJob = 0;
const reads = new Map<
  number,
  { resolve(v: any): void; reject(e: Error): void }
>();
const jobs = new Map<number, AbortController>();
let runtime: ChatDataRuntime;
let queue: Promise<unknown> = Promise.resolve();
function rpc(source: number, method: string, args: unknown[]) {
  const id = ++sequence,
    job = currentJob;
  return new Promise<any>((resolve, reject) => {
    reads.set(id, { resolve, reject });
    postMessage({ type: "read", id, job, source, method, args });
  });
}
self.onmessage = ({ data: m }) => {
  if (m.type === "reply") {
    const p = reads.get(m.id);
    reads.delete(m.id);
    if (m.error) p?.reject(new Error(m.error));
    else p?.resolve(m.value);
    return;
  }
  if (m.type === "cancel") {
    jobs.get(m.id)?.abort();
    return;
  }
  if (m.type === "init") {
    const readers = m.sources.map((s: any, source: number) => {
      const store: BlockStore | undefined = s.store
        ? {
            available: true,
            getIndex: (id) => rpc(source, "getIndex", [id]),
            putIndex: (id, value) => rpc(source, "putIndex", [id, value]),
            get: (snapshot, block) => rpc(source, "get", [snapshot, block]),
            put: (snapshot, block, bytes) =>
              rpc(source, "put", [snapshot, block, bytes]),
            keys: (snapshot) => rpc(source, "keys", [snapshot]),
          }
        : undefined;
      const seed = new AtlasReader(
        { read: (a, b) => rpc(source, "range", [a, b]) },
        undefined,
        {
          store,
          purposes: ["search", "features"],
          cacheBudgets: { semantic: 8 * 1024 ** 2 },
        },
      );
      seed.index = s.index;
      const reader = seed.fork();
      seed.dispose();
      return reader;
    });
    runtime = new ChatDataRuntime(readers);
    postMessage({ type: "ready" });
    return;
  }
  if (m.type !== "call") return;
  const controller = new AbortController();
  jobs.set(m.id, controller);
  queue = queue
    .catch(() => {})
    .then(async () => {
      currentJob = m.id;
      try {
        controller.signal.throwIfAborted();
        for (const r of runtime.readers) r.offline = m.offline === true;
        let value: unknown;
        if (m.name === "__catalog") value = runtime.definitions();
        else if (m.name === "__resolve")
          value = await runtime.resolve(m.input.result);
        else if (m.name === "__save")
          value = runtime.results.save(m.input.collection, m.input.meta);
        else if (m.name === "__clear") {
          runtime.clear();
          value = {};
        } else value = await runtime.invoke(m.name, m.input, controller.signal);
        controller.signal.throwIfAborted();
        postMessage({ type: "result", id: m.id, value });
      } catch (e) {
        postMessage({
          type: "error",
          id: m.id,
          error: e instanceof Error ? e.message : String(e),
          code: (e as { code?: string })?.code,
        });
      } finally {
        jobs.delete(m.id);
        currentJob = 0;
      }
    });
};
