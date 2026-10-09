import { routingCapability } from "../../format/src/capabilities";
import { TRANSPORT_MODES, type TransportMode } from "../../format/src/index";
import type { FeatureCollection, MultiPolygon } from "geojson";
export type { TransportMode };
import { PagedRouter, readRoutingCell, type RoutingProgress } from "./paged";
import init, { WalkingRouter } from "../pkg/atlas_routing_wasm";
import { AtlasReader } from "../../format/src/reader";
export type Position = [number, number];
export interface Snap {
  coordinates: Position;
  distanceMeters: number;
  wayId: string;
}
export type WalkingResult =
  | {
      status: "found";
      coordinates: Position[];
      meters: number;
      seconds?: number;
      visited: number;
      start: Snap;
      end: Snap;
      wayIds: string[];
    }
  | { status: "no-route"; start: Snap; end: Snap; visited: number }
  | { status: "unsnappable"; endpoint: "start" | "end"; limitMeters: number };
export interface ResultMetrics {
  cells?: RoutingProgress;
  profile?: TransportMode;
  snapshot: string;
  computeMs: number;
  graphCached: boolean;
  graphBytes: number;
}
export type Incomplete =
  | { status: "missing-data"; missing: string[]; reason: string }
  | { status: "budget-exceeded" };
export interface Reachable {
  status: "reachable";
  start: Snap;
  visited: number;
  contours: FeatureCollection<
    MultiPolygon,
    { seconds: number; minutes: number; areaKm2: number; approximate: true }
  >;
  resolutionMeters: number;
  segments: number;
}
export type RouteResult = (WalkingResult | Incomplete) & ResultMetrics;
export type IsochroneResult = (
  | Reachable
  | Exclude<WalkingResult, { status: "found" }>
  | Incomplete
) &
  ResultMetrics;
export function validateTransport(
  profile: unknown,
  bands?: unknown,
): asserts profile is TransportMode {
  if (!TRANSPORT_MODES.includes(profile as TransportMode))
    throw new Error("Unknown transport mode");
  if (
    bands !== undefined &&
    (!Array.isArray(bands) ||
      bands.length < 1 ||
      bands.length > 4 ||
      !bands.every(
        (n, i) =>
          typeof n === "number" &&
          Number.isFinite(n) &&
          n > 0 &&
          n <= 1800 &&
          (!i || n > bands[i - 1]),
      ))
  )
    throw new Error("Use 1–4 increasing time bands between 0 and 1800 seconds");
}
export function profilePrefix(reader: AtlasReader, mode: TransportMode) {
  validateTransport(mode);
  const capability = routingCapability(reader.index.manifest, mode);
  if (capability?.storage === "cells") return capability.prefix;
  throw new Error(
    `${mode} cells are unavailable. Compile transport data for this package.`,
  );
}
/** The same verified Rust/WASM engine runs in the browser or on the server. */
export class AtlasRouter {
  private engine?: WalkingRouter;
  private paged?: PagedRouter;
  private loading?: Promise<void>;
  private dead = false;
  constructor(
    readonly reader: AtlasReader,
    readonly initialize: () => Promise<unknown> = () =>
      init({ module_or_path: "/wasm/atlas_routing_wasm_bg.wasm" }),
    readonly options: {
      reference?: boolean;
      onProgress?: (p: RoutingProgress) => void;
    } = {},
  ) {}
  async route(
    start: Position,
    end: Position,
    profile: TransportMode = "walking",
  ): Promise<RouteResult> {
    validateTransport(profile);
    if (
      this.reader.options.purposes &&
      !this.reader.options.purposes.includes("routing")
    )
      throw new Error("Routing is disabled");
    if (this.dead) throw new Error("Router has been disposed");
    if (
      routingCapability(this.reader.index.manifest, profile)?.storage ===
        "cells" &&
      !this.options.reference
    ) {
      return this.getPaged().route(
        start,
        end,
        profile,
        profilePrefix(this.reader, profile),
      );
    }
    if (profile !== "walking")
      throw new Error("This package only supports walking");
    const metadata = this.reader.index.manifest.routing;
    if (
      !metadata ||
      !this.reader.index.manifest.capabilities.includes("walking-routing")
    )
      throw new Error(
        "This package has no walking graph. Regenerate it with the current CLI.",
      );
    if (
      this.reader.options.purposes &&
      !this.reader.options.purposes.includes("routing")
    )
      throw new Error("Routing is disabled");
    const graphCached = !!this.engine || this.reader.cache.has(metadata.block);
    if (!this.engine) {
      if (!graphCached && this.reader.offline)
        throw new Error(
          "Walking graph is not cached. Turn off Cache only and try again to fetch it.",
        );
      this.loading ??= (async () => {
        await this.initialize();
        const bytes = await this.reader.block(metadata.block);
        if (this.dead) throw new Error("Router has been disposed");
        this.engine = new WalkingRouter(bytes);
      })().finally(() => {
        this.loading = undefined;
      });
      await this.loading;
    }
    if (this.dead) throw new Error("Router has been disposed");
    const begin = performance.now();
    const result = JSON.parse(
      this.engine!.route(...start, ...end),
    ) as WalkingResult;
    return {
      ...result,
      snapshot: this.reader.index.manifest.snapshot,
      computeMs: performance.now() - begin,
      graphCached,
      graphBytes: this.reader.index.blocks.find(
        (b) => b.key === metadata.block,
      )!.length,
    };
  }
  private getPaged() {
    return (this.paged ??= new PagedRouter(
      this.reader.index.manifest.snapshot,
      (key) => readRoutingCell(this.reader, key),
      this.options.onProgress,
      this.initialize,
    ));
  }
  isochrone(
    start: Position,
    bands: number[],
    profile: TransportMode = "walking",
  ): Promise<IsochroneResult> {
    validateTransport(profile, bands);
    if (
      this.reader.options.purposes &&
      !this.reader.options.purposes.includes("routing")
    )
      throw new Error("Routing is disabled");
    if (this.dead) throw new Error("Router has been disposed");
    return this.getPaged().isochrone(
      start,
      bands,
      profile,
      profilePrefix(this.reader, profile),
    );
  }
  destroy() {
    this.dead = true;
    this.paged?.destroy();
    this.engine?.free();
    this.engine = undefined;
  }
}
