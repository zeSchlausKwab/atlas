import { RoutingComposition } from "../../../packages/routing/src/composition";
import type { RoutingBudget } from "../../../packages/routing/src/paged";
import { requirementAvailable } from "../../../packages/operations/src/registry";
import { installedPlugins } from "../../../packages/operations/src/installed";
import { runPlugin } from "./plugin-runner";
import type { CatalogEntry } from "../../../packages/operations/src/registry";
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
  private pluginAbort?: AbortController;
  readonly controller = new OperationController();
  private transportOwner?: "route" | "isochrone";
  private progress?: (p: RoutingProgress) => void;
  subscribeProgress(listener: (p: RoutingProgress) => void) {
    return this.controller.subscribe((e) => listener(e.progress));
  }
  private workerRouter?: WorkerRouter;
  readonly composition?: RoutingComposition;
  readonly compositionError?: string;
  readonly composed: boolean;
  routingBudget: RoutingBudget = {};
  get transportProfiles(): TransportMode[] {
    // Remote tools are scoped to Tool source, even inside a composition.
    if (this.mode === "server" || !this.composed)
      return this.engine.capabilities.operations.route.parameters.profiles;
    return this.composition
      ? (["walking", "cycling", "driving"] as TransportMode[]).filter((mode) =>
          this.composition!.sources.some(
            (s) => !!s.reader.index.manifest.transport?.profiles[mode],
          ),
        )
      : [];
  }
  get routingAvailable() {
    return (
      this.enabled.has("routing") &&
      this.transportProfiles.includes(this.profile)
    );
  }
  get isochroneAvailable() {
    return (
      this.routingAvailable &&
      (this.mode === "device" && this.composed
        ? !!this.composition
        : this.engine.capabilities.operations.isochrone.parameters.profiles.includes(
            this.profile,
          ))
    );
  }
  setRoutingBudget(budget: RoutingBudget) {
    this.controller.cancel();
    this.workerRouter?.cancel();
    this.workerRouter = undefined;
    this.routingBudget = budget;
  }
  private routingBytes() {
    return this.composition
      ? this.composition.sources.reduce(
          (n, s) => n + s.reader.bytesByPurpose.routing,
          0,
        )
      : this.reader.bytesByPurpose.routing;
  }
  constructor(
    readonly reader: AtlasReader,
    readonly onExecution: (e: Execution) => void,
    readonly sources?: { id: string; reader: AtlasReader }[],
  ) {
    this.engine = new AtlasEngine(
      reader,
      undefined,
      sources?.length ? sources.map((s) => s.reader) : [reader],
    );
    this.composed = sources !== undefined;
    if (sources) {
      try {
        this.composition = new RoutingComposition(
          sources.filter((s) => !!s.reader.index.manifest.transport),
        );
      } catch (e) {
        this.compositionError = String(e);
      }
      this.routingBudget = { searchStates: 2_000_000 };
    }
    this.selectedProfile = this.composition?.sources.every(
      (s) => !!s.reader.index.manifest.transport?.profiles.driving,
    )
      ? "driving"
      : (this.transportProfiles[0] ?? "walking");
    if (reader.source instanceof HttpSource)
      this.remote = new RemoteOperations(
        reader.source.apiUrl ??
          new URL(reader.source.url, location.href).href.replace(
            /\.atlas(?:\?.*)?$/,
            "/api",
          ),
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
      this.pluginAbort?.abort();
      this.workerRouter?.cancel();
      this.transportOwner = undefined;
      this.engine.workspace.clear();
    }
    this.mode = nextMode;
    if (!this.transportProfiles.includes(this.profile))
      this.profile = this.transportProfiles[0] ?? "walking";
    this.enabled = new Set(enabled);
    for (const source of this.sources ?? [])
      source.reader.options.purposes = [
        "map",
        "labels",
        ...(enabled.includes("routing") ? ["routing" as const] : []),
      ];
    this.reader.options.purposes = [
      "map",
      "labels",
      ...enabled,
    ] as DataPurpose[];
  }
  private check(op: Operation, mode = this.mode) {
    const p = purposes[op];
    if (p && !this.enabled.has(p))
      throw new Error(`${p} is disabled in Data settings.`);
    if (this.dead) throw new Error("Package closed");
    if (
      mode === "device" &&
      this.composed &&
      (op === "route" || op === "isochrone")
    ) {
      if (!this.composition)
        throw new Error(
          this.compositionError ?? "No compatible transport maps selected.",
        );
      return;
    }
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
    this.check(op, mode);
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
          before = transport ? this.routingBytes() : this.reader.bytesRead;
        const result = await local(request);
        signal.throwIfAborted();
        const execution: Execution = {
          side: "device",
          operation: op,
          computeMs: performance.now() - start,
          sourceBytes:
            (transport ? this.routingBytes() : this.reader.bytesRead) - before,
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
      !this.composition &&
      routingCapability(this.reader.index.manifest, profile)?.storage !==
        "cells"
    )
      return this.engine.route(start, end, profile);
    this.workerRouter ??= new WorkerRouter(
      this.composition ?? this.reader,
      (p) => this.progress?.(p),
      this.routingBudget,
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
    this.workerRouter ??= new WorkerRouter(
      this.composition ?? this.reader,
      (p) => this.progress?.(p),
      this.routingBudget,
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
  async catalog(signal?: AbortSignal): Promise<CatalogEntry[]> {
    if (this.mode === "server" && this.remote) {
      if (this.reader.offline)
        throw new Error("Server tools need a connection.");
      const response = await fetch(`${this.remote.url}/capabilities`, {
        signal,
      });
      if (!response.ok) throw new Error("Could not load server tools");
      const catalog = await response.json();
      if (catalog.snapshot !== this.reader.index.manifest.snapshot)
        throw new Error("Server snapshot changed; reopen the package.");
      return catalog.plugins;
    }
    return [
      ...this.engine.registry.catalog(),
      ...installedPlugins.map((p) => ({
        ...p.descriptor,
        implementation: p.implementation,
        enabled: true,
        available: p.descriptor.requirements.every((r) =>
          requirementAvailable(this.reader.index.manifest, r),
        ),
      })),
    ];
  }
  async invokePlugin(
    d: CatalogEntry,
    input: unknown,
    signal: AbortSignal,
    progress: (message: string) => void = () => {},
    mode = this.mode,
  ) {
    if (this.dead) throw new Error("Package closed");
    if (!d.execution.includes(mode))
      throw new Error(`This tool does not support ${mode} execution.`);
    for (const purpose of d.purposes)
      if (!this.enabled.has(purpose as Capability))
        throw new Error(`${purpose} is disabled in Data settings.`);
    if (d.id === "workspace_prepare") {
      const families = (input as { families?: string[] })?.families ?? [];
      for (const family of families) {
        const purpose = family === "locations" ? "search" : "features";
        if (!this.enabled.has(purpose))
          throw new Error(`${purpose} is disabled in Data settings.`);
      }
    }
    if (!d.enabled || !d.available)
      throw new Error("This tool is unavailable or disabled by the host.");
    this.pluginAbort?.abort();
    const controller = (this.pluginAbort = new AbortController());
    const combined = AbortSignal.any([signal, controller.signal]);
    const request = structuredClone(input),
      start = performance.now(),
      before = this.reader.bytesRead + this.engine.workspace.bytesRead;
    if (mode === "server") {
      if (!this.remote || this.reader.offline)
        throw new Error("Server tools need a connection.");
      const response = await fetch(
        `${this.remote.url}/${encodeURIComponent(d.id)}`,
        {
          signal: combined,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            snapshot: this.reader.index.manifest.snapshot,
            version: d.version,
            implementation: d.implementation,
            input: request,
          }),
        },
      );
      const bytes = await response.arrayBuffer(),
        data = JSON.parse(new TextDecoder().decode(bytes));
      if (!response.ok) throw new Error(data.error ?? "Tool failed");
      if (
        data.provenance?.snapshot !== this.reader.index.manifest.snapshot ||
        data.provenance?.implementation !== d.implementation
      )
        throw new Error("Tool result identity mismatch");
      combined.throwIfAborted();
      data.execution.responseBytes = bytes.byteLength;
      this.record(data.execution);
      return data;
    }
    let result: unknown;
    if (installedPlugins.some((p) => p.descriptor.id === d.id))
      result = await runPlugin(this.reader, d, request, combined, progress);
    else {
      // Existing convenience tools keep their worker-backed transport implementation.
      this.engine.registry.check(d, request);
      const i = request as any;
      if (d.id === "route" || d.id === "isochrone") {
        const operation = d.id;
        const cancel = () => this.cancelRoute(operation);
        combined.throwIfAborted();
        combined.addEventListener("abort", cancel, { once: true });
        try {
          const withExecution =
            operation === "route"
              ? await this.run(
                  "route",
                  i,
                  (p) =>
                    this.localRoute(p.start, p.end, p.profile ?? "walking"),
                  "device",
                )
              : await this.run(
                  "isochrone",
                  i,
                  (p) =>
                    this.localIsochrone(
                      p.start,
                      p.bands,
                      p.profile ?? "walking",
                    ),
                  "device",
                );
          const { execution: _execution, ...value } = withExecution;
          result = value;
        } finally {
          combined.removeEventListener("abort", cancel);
        }
      } else
        result = await this.engine.registry.invoke(
          d,
          request,
          combined,
          progress,
        );
    }
    combined.throwIfAborted();
    const execution: Execution = {
      side: "device",
      operation: d.id,
      computeMs: performance.now() - start,
      sourceBytes:
        this.reader.bytesRead + this.engine.workspace.bytesRead - before,
      responseBytes: 0,
    };
    this.record(execution);
    return {
      result,
      execution,
      provenance: {
        id: d.id,
        version: d.version,
        implementation: d.implementation,
        snapshot: this.reader.index.manifest.snapshot,
      },
    };
  }
  destroy() {
    this.dead = true;
    this.pluginAbort?.abort();
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
