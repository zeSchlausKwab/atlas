import { PagedRouter, readRoutingCell, type RoutingProgress } from "./paged";
import init, { WalkingRouter } from "../../renderer/pkg/atlas_renderer";
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
      visited: number;
      start: Snap;
      end: Snap;
      wayIds: string[];
    }
  | { status: "no-route"; start: Snap; end: Snap; visited: number }
  | { status: "unsnappable"; endpoint: "start" | "end"; limitMeters: number };
export type RouteResult = (
  | WalkingResult
  | { status: "missing-data"; missing: string[]; reason: string }
  | { status: "budget-exceeded" }
) & {
  cells?: RoutingProgress;
  snapshot: string;
  computeMs: number;
  graphCached: boolean;
  graphBytes: number;
};
/** The same verified Rust/WASM engine runs in the browser or on the server. */
export class AtlasRouter {
  private engine?: WalkingRouter;
  private paged?: PagedRouter;
  private loading?: Promise<void>;
  private dead = false;
  constructor(
    readonly reader: AtlasReader,
    readonly initialize: () => Promise<unknown> = () =>
      init({ module_or_path: "/wasm/atlas_renderer_bg.wasm" }),
    readonly options: {
      reference?: boolean;
      onProgress?: (p: RoutingProgress) => void;
    } = {},
  ) {}
  async route(start: Position, end: Position): Promise<RouteResult> {
    if (this.dead) throw new Error("Router has been disposed");
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
    if (metadata.cells && !this.options.reference) {
      this.paged ??= new PagedRouter(
        this.reader.index.manifest.snapshot,
        (key) => readRoutingCell(this.reader, key),
        this.options.onProgress,
        this.initialize,
      );
      return this.paged.route(start, end);
    }
    const graphCached = this.reader.cache.has(metadata.block);
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
  destroy() {
    this.dead = true;
    this.paged?.destroy();
    this.engine?.free();
    this.engine = undefined;
  }
}
