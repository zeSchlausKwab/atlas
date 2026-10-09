import type { AtlasReader } from "../../../packages/format/src/reader";
import type { CatalogEntry } from "../../../packages/operations/src/registry";
/** Byte reads stay in the shared reader/cache. Decoding and plugin computation stay off the UI thread. */
export function runPlugin(
  reader: AtlasReader,
  descriptor: CatalogEntry,
  input: unknown,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker("/plugin-worker.js", { type: "module" });
    let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      worker.terminate();
      signal.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(result);
    };
    const cancel = () =>
      finish(new DOMException("Tool cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = () => finish(new Error("Plugin worker failed"));
    const allowed = new Set<string>();
    worker.onmessage = async ({ data: m }) => {
      if (done) return;
      if (m.type === "read") {
        try {
          let value: unknown;
          if (m.method === "spatial") {
            const [family, z, x0, x1, y0, y1] = m.args;
            if (
              !descriptor.requirements.some((r) => r.family === family) ||
              z !== reader.index.manifest.featureZoom ||
              ![x0, x1, y0, y1].every(Number.isInteger) ||
              x1 - x0 > 16 ||
              y1 - y0 > 16
            )
              throw new Error(
                "Plugin requested an undeclared or oversized data region",
              );
            const blocks = await reader.spatial(family, z, x0, x1, y0, y1);
            for (const b of blocks) allowed.add(b.key);
            value = blocks;
          } else if (m.method === "block" && allowed.has(m.args[0]))
            value = await reader.block(m.args[0]);
          else throw new Error("Plugin requested an undeclared data block");
          if (!done) worker.postMessage({ type: "reply", id: m.id, value });
        } catch (e) {
          if (!done)
            worker.postMessage({
              type: "reply",
              id: m.id,
              error: e instanceof Error ? e.message : String(e),
            });
        }
      } else if (m.type === "progress") progress(m.message);
      else if (m.type === "error") finish(new Error(m.error));
      else if (m.type === "result") finish(undefined, m.result);
    };
    worker.postMessage({
      type: "run",
      manifest: reader.index.manifest,
      ref: {
        id: descriptor.id,
        version: descriptor.version,
        implementation: descriptor.implementation,
      },
      input,
    });
  });
}
