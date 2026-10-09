import { selectedCell } from "../../offline/src/geometry";
import init, { CellWalkingRouter } from "../pkg/atlas_routing_wasm";
import type { AtlasReader } from "../../format/src/reader";
import {
  validateTransport,
  type Position,
  type RouteResult,
  type WalkingResult,
  type Reachable,
  type IsochroneResult,
  type TransportMode,
} from "./index";
export interface RoutingBudget {
  cellBytes?: number;
  searchStates?: number;
}
export interface CellRead {
  bytes?: Uint8Array;
  empty?: boolean;
  missing?: boolean;
  reason?: string;
  fetchedBytes: number;
}
export interface RoutingProgress {
  phase: "searching" | "missing-data" | "complete" | "budget-exceeded";
  cells: Array<{
    key: string;
    state: "cached" | "loaded" | "loading" | "missing";
  }>;
  fetchedBytes: number;
  reusedCells: number;
  loadedCells: number;
  residentCells: number;
  memoryBytes: number;
  computeMs: number;
  visited: number;
}
export async function readRoutingCell(
  reader: AtlasReader,
  key: string,
): Promise<CellRead> {
  if (reader.options.purposes && !reader.options.purposes.includes("routing"))
    throw new Error("Routing is disabled");
  const m =
    /^(routing\/(?:(?:walking|cycling|driving)\/)?cells)\/14\/(\d+)\/(\d+)$/.exec(
      key,
    );
  if (!m || +m[2]! >= 16384 || +m[3]! >= 16384)
    throw new Error("Invalid cell request");
  const before = reader.bytesByPurpose.routing;
  try {
    const blocks = await reader.spatial(
      m[1]!,
      14,
      +m[2]!,
      +m[2]!,
      +m[3]!,
      +m[3]!,
    );
    if (!blocks.length) {
      const selection = reader.index.manifest.selection;
      if (
        selection?.routingPaddingCells !== undefined &&
        !selectedCell(
          selection.polygon,
          14,
          +m[2]!,
          +m[3]!,
          selection.routingPaddingCells,
        )
      )
        return {
          missing: true,
          reason:
            "The route or isochrone needs cells beyond this prepared map’s routing coverage.",
          fetchedBytes: 0,
        };
      return { empty: true, fetchedBytes: 0 };
    }
    return {
      bytes: await reader.block(key),
      fetchedBytes: reader.bytesByPurpose.routing - before,
    };
  } catch (e) {
    if (
      (reader.offline &&
        e instanceof Error &&
        e.message.startsWith("Not cached:")) ||
      (e instanceof TypeError && /fetch|network|load/i.test(e.message))
    )
      return {
        missing: true,
        reason: reader.offline
          ? "Cache only is enabled."
          : "The network is unavailable.",
        fetchedBytes: reader.bytesByPurpose.routing - before,
      };
    throw e;
  }
}
type Step =
  | { status: "need-blocks"; keys: string[]; visited: number }
  | { status: "running" | "budget-exceeded"; visited: number }
  | { status: "complete"; result: WalkingResult }
  | { status: "reachable"; result: Reachable };
/** Host-independent orchestration; the browser supplies cell bytes over worker RPC. */
export class PagedRouter {
  private prefix = "routing/cells";
  private profile: TransportMode = "walking";
  private address(key: string) {
    return key.replace("routing/cells", this.prefix);
  }
  private kernel?: CellWalkingRouter;
  private pending?: string;
  private dead = false;
  private tail: Promise<unknown> = Promise.resolve();
  private states = new Map<string, RoutingProgress["cells"][number]["state"]>();
  private fetched = new Set<string>();
  private fetchedBytes = 0;
  private computeMs = 0;
  private visited = 0;
  constructor(
    readonly snapshot: string,
    readonly read: (key: string) => Promise<CellRead>,
    readonly onProgress: (p: RoutingProgress) => void = () => {},
    readonly initialize: () => Promise<unknown> = () =>
      init({ module_or_path: "/wasm/atlas_routing_wasm_bg.wasm" }),
    readonly budget: RoutingBudget = {},
  ) {
    const bytes = budget.cellBytes ?? 96 * 1024 * 1024,
      states = budget.searchStates ?? 250_000;
    if (
      !Number.isInteger(bytes) ||
      bytes < 1048576 ||
      bytes > 256 * 1048576 ||
      !Number.isInteger(states) ||
      states < 1000 ||
      states > 2_000_000
    )
      throw new Error("Invalid routing budget");
  }
  private progress(phase: RoutingProgress["phase"]): RoutingProgress {
    const used =
      this.kernel
        ?.used_keys()
        .split(",")
        .filter(Boolean)
        .map((k) => this.address(k)) ?? [];
    for (const key of used)
      if (!this.states.has(key)) this.states.set(key, "cached");
    const progress = {
      phase,
      cells: [...this.states].map(([key, state]) => ({ key, state })),
      fetchedBytes: this.fetchedBytes,
      reusedCells: used.filter((k) => !this.fetched.has(k)).length,
      loadedCells: used.length,
      residentCells: this.kernel?.cell_count() ?? 0,
      memoryBytes: this.kernel?.memory_bytes() ?? 0,
      computeMs: this.computeMs,
      visited: this.visited,
    };
    this.onProgress(progress);
    return progress;
  }
  route(
    a: Position,
    b: Position,
    profile: TransportMode = "walking",
    prefix = "routing/cells",
  ): Promise<RouteResult> {
    return this.enqueue(a, b, profile, prefix) as Promise<RouteResult>;
  }
  isochrone(
    a: Position,
    bands: number[],
    profile: TransportMode = "walking",
    prefix = "routing/cells",
  ): Promise<IsochroneResult> {
    validateTransport(profile, bands);
    return this.enqueue(
      a,
      a,
      profile,
      prefix,
      bands,
    ) as Promise<IsochroneResult>;
  }
  private enqueue(
    a: Position,
    b: Position,
    profile: TransportMode,
    prefix: string,
    bands?: number[],
  ) {
    validateTransport(profile, bands);
    const work = this.tail.then(() => this.run(a, b, profile, prefix, bands));
    this.tail = work.catch(() => {});
    return work;
  }
  private async run(
    a: Position,
    b: Position,
    profile: TransportMode,
    prefix: string,
    bands?: number[],
  ): Promise<RouteResult | IsochroneResult> {
    if (this.dead) throw new Error("Router disposed");
    if (!this.kernel) {
      await this.initialize();
      if (this.dead) throw new Error("Router disposed");
      this.kernel = CellWalkingRouter.with_limits(
        this.budget.cellBytes ?? 96 * 1024 * 1024,
        this.budget.searchStates ?? 250_000,
      );
    }
    const signature = JSON.stringify([a, b, profile, prefix, bands]);
    this.prefix = prefix;
    this.profile = profile;
    if (this.pending !== signature) {
      this.kernel.set_profile(
        ["walking", "cycling", "driving"].indexOf(profile),
      );
      if (bands) this.kernel.begin_isochrone(...a, new Float64Array(bands));
      else this.kernel.begin(...a, ...b);
      this.states.clear();
      this.fetched.clear();
      this.fetchedBytes = 0;
      this.computeMs = 0;
      this.visited = 0;
    }
    this.pending = signature;
    while (!this.dead) {
      const before = performance.now();
      const step = JSON.parse(this.kernel.step()) as Step;
      this.computeMs += performance.now() - before;
      if ("visited" in step) this.visited = step.visited;
      if (step.status === "complete" || step.status === "reachable") {
        this.pending = undefined;
        if ("visited" in step.result) this.visited = step.result.visited;
        const progress = this.progress("complete");
        return {
          ...step.result,
          snapshot: this.snapshot,
          profile,
          computeMs: this.computeMs,
          graphCached: this.fetchedBytes === 0,
          graphBytes: this.fetchedBytes,
          cells: progress,
        };
      }
      if (step.status === "budget-exceeded") {
        this.pending = undefined;
        return {
          status: "budget-exceeded",
          snapshot: this.snapshot,
          profile,
          computeMs: this.computeMs,
          graphCached: this.fetchedBytes === 0,
          graphBytes: this.fetchedBytes,
          cells: this.progress("budget-exceeded"),
        };
      }
      if (step.status === "need-blocks") {
        const keys = step.keys.map((k) => this.address(k));
        for (const key of keys) this.states.set(key, "loading");
        this.progress("searching");
        const missing: string[] = [];
        let reason = "";
        for (const key of keys) {
          const data = await this.read(key);
          if (this.dead) throw new Error("Router disposed");
          this.fetchedBytes += data.fetchedBytes;
          if (data.missing) {
            missing.push(key);
            reason = data.reason ?? "";
            this.states.set(key, "missing");
          } else if (data.empty) {
            const p = key.split("/").slice(-2);
            this.kernel.empty(+p[0]!, +p[1]!);
            this.states.delete(key);
          } else if (data.bytes) {
            const view = new DataView(
                data.bytes.buffer,
                data.bytes.byteOffset,
                data.bytes.byteLength,
              ),
              parts = key.split("/").slice(-2);
            if (
              data.bytes.length < 16 ||
              view.getUint32(8, true) !== +parts[0]! ||
              view.getUint32(12, true) !== +parts[1]!
            )
              throw new Error("Routing cell address mismatch");
            const t = performance.now();
            this.kernel.load(data.bytes);
            this.computeMs += performance.now() - t;
            this.states.set(key, data.fetchedBytes ? "loaded" : "cached");
            if (data.fetchedBytes) this.fetched.add(key);
          } else throw new Error("Invalid routing cell response");
        }
        if (missing.length)
          return {
            status: "missing-data",
            missing,
            reason,
            snapshot: this.snapshot,
            profile,
            computeMs: this.computeMs,
            graphCached: this.fetchedBytes === 0,
            graphBytes: this.fetchedBytes,
            cells: this.progress("missing-data"),
          };
      }
      this.progress("searching");
      // Yield between bounded WASM batches, including on the Bun server.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Router disposed");
  }
  destroy() {
    this.dead = true;
    this.kernel?.free();
    this.kernel = undefined;
  }
}
