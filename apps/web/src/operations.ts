import { routingCapability } from "../../../packages/format/src/capabilities";
import { OperationController } from "../../../packages/operations/src/controller";
import type {
  OperationInputs,
  OperationResults,
} from "../../../packages/operations/src/contract";
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
  private selectedProfile: TransportMode = "walking";
  get profile() {
    return this.selectedProfile;
  }
  set profile(value: TransportMode) {
    if (value === this.selectedProfile) return;
    this.controller.cancel();
    this.workerRouter?.cancel();
    this.transportOwner = undefined;
    this.selectedProfile = value;
  }
  mode: "device" | "server" = "device";
  enabled = new Set<Capability>(["routing", "search", "queries", "features"]);
  apiBytes = 0;
  apiRequests = 0;
  private dead = false;
  readonly controller = new OperationController();
  private transportOwner?: "route" | "isochrone";
  private progress?: (p: RoutingProgress) => void;
  subscribeProgress(listener: (p: RoutingProgress) => void) {
    return this.controller.subscribe((e) => listener(e.progress));
  }
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
    const nextMode = this.remote ? mode : "device";
    if (
      nextMode !== this.mode ||
      [...this.enabled].some((p) => !enabled.includes(p))
    ) {
      this.controller.cancel();
      this.workerRouter?.cancel();
      this.transportOwner = undefined;
    }
    this.mode = nextMode;
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
    if (!this.engine.capabilities.operations[op].available)
      throw new Error(`${op} is not available in this package.`);
  }
  private record(e: Execution) {
    if (this.dead) return;
    if (e.side === "server") {
      this.apiBytes += e.responseBytes;
      this.apiRequests++;
    }
    this.onExecution(e);
  }
  private run<K extends Operation>(
    op: K,
    input: OperationInputs[K],
    local: (input: OperationInputs[K]) => Promise<OperationResults[K]>,
    mode = this.mode,
  ) {
    this.check(op);
    return this.controller.run(op, input, async (request, signal, progress) => {
      const transport = op === "route" || op === "isochrone";
      if (transport) {
        this.transportOwner = op;
        this.progress = progress;
      }
      const cancel = () => {
        if (transport && this.transportOwner === op)
          this.workerRouter?.cancel();
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (mode === "server") {
          if (!this.remote)
            throw new Error(
              "Server execution is unavailable for this local file.",
            );
          if (this.reader.offline)
            throw new Error(
              "Server execution needs a connection. Turn off Cache only or choose This device.",
            );
          const r = await this.remote.call(op, request, signal);
          signal.throwIfAborted();
          this.record(r.execution);
          return Object.assign(r.result, { execution: r.execution });
        }
        const start = performance.now(),
          before = transport
            ? this.reader.bytesByPurpose.routing
            : this.reader.bytesRead;
        const result = await local(request);
        signal.throwIfAborted();
        const execution: Execution = {
          side: "device",
          operation: op,
          computeMs: performance.now() - start,
          sourceBytes:
            (transport
              ? this.reader.bytesByPurpose.routing
              : this.reader.bytesRead) - before,
          responseBytes: 0,
        };
        this.record(execution);
        if (transport && "cells" in result && result.cells)
          progress(result.cells);
        return Object.assign(result, { execution });
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    });
  }
  private localRoute(start: Position, end: Position, profile: TransportMode) {
    if (
      routingCapability(this.reader.index.manifest, profile)?.storage !==
      "cells"
    )
      return this.engine.route(start, end, profile);
    this.workerRouter ??= new WorkerRouter(this.reader, (p) =>
      this.progress?.(p),
    );
    return this.workerRouter.route(start, end, profile);
  }
  cancelRoute(owner: "route" | "isochrone" = "route") {
    this.controller.cancel(owner);
    if (this.transportOwner === owner) {
      this.workerRouter?.cancel();
      this.transportOwner = undefined;
    }
  }
  private localIsochrone(
    start: Position,
    bands: number[],
    profile: TransportMode,
  ) {
    this.workerRouter ??= new WorkerRouter(this.reader, (p) =>
      this.progress?.(p),
    );
    return this.workerRouter.isochrone(start, bands, profile);
  }
  route(start: Position, end: Position) {
    return this.run("route", { start, end, profile: this.profile }, (p) =>
      this.localRoute(p.start, p.end, p.profile!),
    );
  }
  isochrone(start: Position, bands: number[]) {
    return this.run("isochrone", { start, bands, profile: this.profile }, (p) =>
      this.localIsochrone(p.start, p.bands, p.profile!),
    );
  }
  async compareIsochrone(start: Position, bands: number[]) {
    const input = structuredClone({ start, bands, profile: this.profile });
    const device = await this.run(
      "isochrone",
      input,
      (p) => this.localIsochrone(p.start, p.bands, p.profile!),
      "device",
    );
    if (input.profile !== this.profile)
      throw new DOMException("Profile changed", "AbortError");
    const server = await this.run(
      "isochrone",
      input,
      (p) => this.localIsochrone(p.start, p.bands, p.profile!),
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
    return this.run("search", { query }, (p) =>
      this.engine.search(p.query, p.limit),
    );
  }
  reverse(point: Position) {
    return this.run("reverse", { point }, (p) => this.engine.reverse(p.point));
  }
  peak() {
    return this.run("peak", {}, () => this.engine.peak());
  }
  query(q: FeatureQuery) {
    return this.run("features", q, (p) => this.engine.query(p));
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
    return this.run("offline", s, (p) => this.engine.offline(p));
  }
  async compareRoute(start: Position, end: Position) {
    const input = structuredClone({ start, end, profile: this.profile });
    const device = await this.run(
      "route",
      input,
      (p) => this.localRoute(p.start, p.end, p.profile!),
      "device",
    );
    if (input.profile !== this.profile)
      throw new DOMException("Profile changed", "AbortError");
    const server = await this.run(
      "route",
      input,
      (p) => this.localRoute(p.start, p.end, p.profile!),
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
    this.controller.destroy();
    this.workerRouter?.cancel();
    this.engine.destroy();
  }
}
export function executionText(e: Execution) {
  return e.side === "server"
    ? `Server · ${e.computeMs.toFixed(0)} ms · ${(e.responseBytes / 1000).toFixed(1)} KB returned`
    : `This device · ${e.computeMs.toFixed(0)} ms · ${(e.sourceBytes / 1e6).toFixed(2)} MB read`;
}
