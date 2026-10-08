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
export type RouteResult = WalkingResult & {
  snapshot: string;
  computeMs: number;
  graphCached: boolean;
  graphBytes: number;
};
/** Lazy, verified graph loading; the server only delivers bytes. */
export class AtlasRouter {
  private engine?: WalkingRouter;
  private loading?: Promise<void>;
  private dead = false;
  constructor(readonly reader: AtlasReader) {}
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
    const graphCached = this.reader.cache.has(metadata.block);
    if (!this.engine) {
      if (!graphCached && this.reader.offline)
        throw new Error(
          "Walking graph is not cached. Turn off Cache only and try again to fetch it.",
        );
      this.loading ??= (async () => {
        await init({ module_or_path: "/wasm/atlas_renderer_bg.wasm" });
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
    this.engine?.free();
    this.engine = undefined;
  }
}
