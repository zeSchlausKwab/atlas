import { OperationError, type OperationRef } from "./registry";
import type { AtlasEngine } from "./index";
export interface Invocation extends OperationRef { snapshot: string; input: unknown }
/** Both HTTP and MCP share this bounded executor and revocation checks. */
export class OperationHost {
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly engine: AtlasEngine) {}
  catalog() { return { ...this.engine.capabilities, plugins: this.engine.registry.catalog() }; }
  validate(request: Invocation) {
    if (request.snapshot !== this.engine.reader.index.manifest.snapshot) throw new OperationError("Server snapshot differs from the open package. Reopen the map.", 409);
    this.engine.registry.check(request, request.input);
  }
  async invoke(request: Invocation, signal = new AbortController().signal) {
    const pinned = structuredClone(request);
    this.validate(pinned);
    if (this.pending >= 8) throw new OperationError("Server is busy; retry shortly.", 429);
    this.pending++;
    const work = this.tail.then(async () => {
      this.validate(pinned); signal.throwIfAborted();
      const started = performance.now(), before = this.engine.reader.bytesRead;
      const result = await this.engine.registry.invoke(pinned, pinned.input, signal);
      return { result, execution: { side: "server" as const, operation: pinned.id, computeMs: performance.now() - started, sourceBytes: this.engine.reader.bytesRead - before, responseBytes: 0 },
        provenance: { id: pinned.id, version: pinned.version, implementation: pinned.implementation, snapshot: pinned.snapshot } };
    }).finally(() => { this.pending--; });
    this.tail = work.catch(() => {});
    return work;
  }
}
