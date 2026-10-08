import { WorkerRouter } from "./worker-router";
import type { RoutingProgress } from "../../../packages/routing/src/paged";
import {
  AtlasEngine,
  RemoteOperations,
  type Execution,
  type Operation,
} from "../../../packages/operations/src/index";
import {
  AtlasReader,
  HttpSource,
  type DataPurpose,
} from "../../../packages/format/src/reader";
import type {
  Position,
  TransportMode,
} from "../../../packages/routing/src/index";
import type { FeatureQuery } from "../../../packages/features/src/index";
import type { Selection } from "../../../packages/offline/src/index";
export type Capability = "routing" | "search" | "queries" | "features";
const purposes: Record<Operation, Capability | undefined> = {
  route: "routing",
  isochrone: "routing",
  search: "search",
  reverse: "search",
  peak: "queries",
  features: "features",
  offline: undefined,
};
export class OperationSession {
  readonly engine: AtlasEngine;
  readonly remote?: RemoteOperations;
  profile: TransportMode = "walking";
  mode: "device" | "server" = "device";
  enabled = new Set<Capability>(["routing", "search", "queries", "features"]);
  apiBytes = 0;
  apiRequests = 0;
  private dead = false;
  onRouteProgress?: (p: RoutingProgress) => void;
  private workerRouter?: WorkerRouter;
  constructor(
    readonly reader: AtlasReader,
    readonly onExecution: (e: Execution) => void,
  ) {
    this.engine = new AtlasEngine(reader);
    if (reader.source instanceof HttpSource)
      this.remote = new RemoteOperations(
        new URL("/api", new URL(reader.source.url, location.href)).href,
        reader.index.manifest.snapshot,
      );
  }
  configure(mode: "device" | "server", enabled: Capability[]) {
    this.mode = this.remote ? mode : "device";
    this.enabled = new Set(enabled);
    this.reader.options.purposes = [
      "map",
      "labels",
      ...enabled,
    ] as DataPurpose[];
  }
  private check(op: Operation) {
    const p = purposes[op];
    if (p && !this.enabled.has(p))
      throw new Error(`${p} is disabled in Data settings.`);
    if (this.dead) throw new Error("Package closed");
  }
  private record(e: Execution) {
    if (this.dead) return;
    if (e.side === "server") {
      this.apiBytes += e.responseBytes;
      this.apiRequests++;
    }
    this.onExecution(e);
  }
  private async run<T>(
    op: Operation,
    input: unknown,
    local: () => Promise<T>,
    mode = this.mode,
  ): Promise<T & { execution: Execution }> {
    this.check(op);
    if (mode === "server") {
      if (!this.remote)
        throw new Error("Server execution is unavailable for this local file.");
      if (this.reader.offline)
        throw new Error(
          "Server execution needs a connection. Turn off Cache only or choose This device.",
        );
      const r = await this.remote.call<T>(op, input);
      this.record(r.execution);
      return Object.assign(r.result as object, {
        execution: r.execution,
      }) as T & { execution: Execution };
    }
    const start = performance.now(),
      before =
        op === "route" || op === "isochrone"
          ? this.reader.bytesByPurpose.routing
          : this.reader.bytesRead;
    const result = await local();
    const execution: Execution = {
      side: "device",
      operation: op,
      computeMs: performance.now() - start,
      sourceBytes:
        (op === "route" || op === "isochrone"
          ? this.reader.bytesByPurpose.routing
          : this.reader.bytesRead) - before,
      responseBytes: 0,
    };
    this.record(execution);
    return Object.assign(result as object, { execution }) as T & {
      execution: Execution;
    };
  }
  private localRoute(start: Position, end: Position) {
    if (
      !this.reader.index.manifest.routing?.cells &&
      !this.reader.index.manifest.transport
    )
      return this.engine.route(start, end, this.profile);
    this.workerRouter ??= new WorkerRouter(this.reader, (p) =>
      this.onRouteProgress?.(p),
    );
    return this.workerRouter.route(start, end, this.profile);
  }
  cancelRoute() {
    this.workerRouter?.cancel();
  }
  route(start: Position, end: Position) {
    return this.run("route", { start, end, profile: this.profile }, () =>
      this.localRoute(start, end),
    );
  }
  isochrone(start: Position, bands: number[]) {
    return this.run(
      "isochrone",
      { start, bands, profile: this.profile },
      () => {
        this.workerRouter ??= new WorkerRouter(this.reader, (p) =>
          this.onRouteProgress?.(p),
        );
        return this.workerRouter.isochrone(start, bands, this.profile);
      },
    );
  }
  async compareIsochrone(start: Position, bands: number[]) {
    const input = { start, bands, profile: this.profile };
    const device = await this.run(
      "isochrone",
      input,
      () => {
        this.workerRouter ??= new WorkerRouter(this.reader, (p) =>
          this.onRouteProgress?.(p),
        );
        return this.workerRouter.isochrone(start, bands, this.profile);
      },
      "device",
    );
    const server = await this.run(
      "isochrone",
      input,
      () => this.engine.isochrone(start, bands, this.profile),
      "server",
    );
    return {
      device,
      server,
      same:
        device.status === "reachable" &&
        server.status === "reachable" &&
        JSON.stringify(device.contours) === JSON.stringify(server.contours),
    };
  }
  search(query: string) {
    return this.run("search", { query }, () => this.engine.search(query));
  }
  reverse(point: Position) {
    return this.run("reverse", { point }, () => this.engine.reverse(point));
  }
  peak() {
    return this.run("peak", {}, () => this.engine.peak());
  }
  query(q: FeatureQuery) {
    return this.run("features", q, () => this.engine.query(q));
  }
  checkOffline(s: Selection) {
    for (const p of ["routing", "search", "queries"] as const)
      if (s[p] && !this.enabled.has(p))
        throw new Error(
          `Enable ${p} in Data settings or remove it from this export.`,
        );
  }
  offline(s: Selection) {
    this.checkOffline(s);
    return this.run("offline", s, () => this.engine.offline(s));
  }
  async compareRoute(start: Position, end: Position) {
    const device = await this.run(
      "route",
      { start, end, profile: this.profile },
      () => this.localRoute(start, end),
      "device",
    );
    const server = await this.run(
      "route",
      { start, end, profile: this.profile },
      () => this.localRoute(start, end),
      "server",
    );
    const same =
      device.status === server.status &&
      device.snapshot === server.snapshot &&
      (device.status !== "found" ||
        (server.status === "found" &&
          Math.abs(device.meters - server.meters) < 1e-6 &&
          device.seconds === server.seconds &&
          JSON.stringify(device.coordinates) ===
            JSON.stringify(server.coordinates) &&
          JSON.stringify(device.wayIds) === JSON.stringify(server.wayIds)));
    return { device, server, same };
  }
  destroy() {
    this.dead = true;
    this.workerRouter?.cancel();
    this.engine.destroy();
  }
}
export function executionText(e: Execution) {
  return e.side === "server"
    ? `Server · ${e.computeMs.toFixed(0)} ms · ${(e.responseBytes / 1000).toFixed(1)} KB returned`
    : `This device · ${e.computeMs.toFixed(0)} ms · ${(e.sourceBytes / 1e6).toFixed(2)} MB read`;
}
