import type { CodeOutput } from "../../../../packages/chat/src/sandbox";
/** Warm worker, fresh QuickJS context each run. Stop terminates even a tight loop. */
export class CodeClient {
  private worker?: Worker;
  private reject?: (reason: unknown) => void;
  async run(
    code: string,
    data: unknown,
    signal: AbortSignal,
  ): Promise<CodeOutput> {
    signal.throwIfAborted();
    if (this.reject) throw new Error("Code execution is already running");
    const worker = (this.worker ??= new Worker(
      new URL("/chat-code-worker.js", location.href),
      { type: "module" },
    ));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        this.reject = undefined;
      };
      this.reject = (reason) => {
        cleanup();
        reject(reason);
      };
      const cancel = () => this.destroy(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      worker.onerror = () =>
        this.destroy(new Error("Code worker could not run"));
      worker.onmessageerror = () =>
        this.destroy(new Error("Code output could not be read"));
      worker.onmessage = ({ data }) => {
        cleanup();
        if (data.error) reject(new Error(data.error));
        else resolve(data.value);
      };
      try {
        worker.postMessage({ code, data });
      } catch (error) {
        this.destroy(error);
      }
    });
  }
  destroy(reason: unknown = new Error("Code execution stopped")) {
    this.worker?.terminate();
    this.worker = undefined;
    this.reject?.(reason);
  }
}
