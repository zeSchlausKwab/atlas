import {
  readRoutingCell,
  type RoutingProgress,
} from "../../../packages/routing/src/paged";
import {
  profilePrefix,
  type Position,
  type RouteResult,
  type IsochroneResult,
  type TransportMode,
} from "../../../packages/routing/src/index";
import type { AtlasReader } from "../../../packages/format/src/reader";
export class WorkerRouter {
  private worker?: Worker;
  private sequence = 0;
  private active = 0;
  private jobs = new Map<
    number,
    {
      resolve: (v: RouteResult | IsochroneResult) => void;
      reject: (e: Error) => void;
    }
  >();
  constructor(
    readonly reader: AtlasReader,
    readonly progress: (p: RoutingProgress) => void,
  ) {}
  route(
    start: Position,
    end: Position,
    profile: TransportMode,
  ): Promise<RouteResult> {
    return this.run({
      type: "route",
      start,
      end,
      profile,
    }) as Promise<RouteResult>;
  }
  isochrone(
    start: Position,
    bands: number[],
    profile: TransportMode,
  ): Promise<IsochroneResult> {
    return this.run({
      type: "isochrone",
      start,
      bands,
      profile,
    }) as Promise<IsochroneResult>;
  }
  private run(input: {
    type: string;
    start: Position;
    end?: Position;
    bands?: number[];
    profile: TransportMode;
  }): Promise<RouteResult | IsochroneResult> {
    const prefix = profilePrefix(this.reader, input.profile);
    if (this.jobs.size) this.cancel();
    if (!this.worker) {
      const worker = (this.worker = new Worker("/routing-worker.js", {
        type: "module",
      }));
      worker.onmessage = async ({ data: m }) => {
        if (worker !== this.worker) return;
        if (m.type === "read") {
          try {
            const value = await readRoutingCell(this.reader, m.key);
            if (worker === this.worker)
              worker.postMessage({ type: "cell", id: m.id, value });
          } catch (e) {
            if (worker === this.worker)
              worker.postMessage({
                type: "cell",
                id: m.id,
                error: e instanceof Error ? e.message : String(e),
              });
          }
        } else if (m.type === "progress") {
          if (m.id === this.active) this.progress(m.progress);
        } else {
          const p = this.jobs.get(m.id);
          if (!p) return;
          this.jobs.delete(m.id);
          if (m.type === "error") p.reject(new Error(m.error));
          else p.resolve(m.result);
        }
      };
      worker.onerror = () => this.cancel("Routing worker failed");
    }
    const id = ++this.sequence;
    this.active = id;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker!.postMessage({
        ...input,
        prefix,
        id,
        snapshot: this.reader.index.manifest.snapshot,
      });
    });
  }
  cancel(message = "Routing cancelled") {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.jobs.values()) p.reject(new Error(message));
    this.jobs.clear();
  }
}
