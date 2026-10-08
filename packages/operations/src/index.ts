import { AtlasReader } from "../../format/src/reader";
import { AtlasRouter, type Position } from "../../routing/src/index";
import { AtlasGeocoder } from "../../geocoding/src/index";
import { AtlasFeatures, type FeatureQuery } from "../../features/src/index";
import { extract, type Selection } from "../../offline/src/index";
export type Operation =
  | "route"
  | "search"
  | "reverse"
  | "peak"
  | "features"
  | "offline";
export interface Execution {
  side: "device" | "server";
  operation: Operation;
  computeMs: number;
  sourceBytes: number;
  responseBytes: number;
}
/** Runtime-independent operations. The host supplies WASM initialization and a byte source. */
export class AtlasEngine {
  readonly router: AtlasRouter;
  readonly geocoder: AtlasGeocoder;
  readonly features: AtlasFeatures;
  constructor(
    readonly reader: AtlasReader,
    initialize?: () => Promise<unknown>,
  ) {
    this.router = new AtlasRouter(reader, initialize);
    this.geocoder = new AtlasGeocoder(reader);
    this.features = new AtlasFeatures(reader);
  }
  route(start: Position, end: Position) {
    return this.router.route(start, end);
  }
  search(query: string, limit?: number) {
    return this.geocoder.search(query, limit);
  }
  reverse(point: Position) {
    return this.geocoder.reverse(point);
  }
  peak() {
    return this.reader.highestPeak();
  }
  query(q: FeatureQuery) {
    return this.features.query(q);
  }
  offline(s: Selection, progress?: (message: string) => void) {
    return extract(this.reader, s, progress);
  }
  destroy() {
    this.router.destroy();
  }
}
export class RemoteOperations {
  constructor(
    readonly url: string,
    readonly snapshot: string,
  ) {}
  async call<T>(
    operation: Operation,
    input: unknown,
  ): Promise<{ result: T; execution: Execution }> {
    const response = await fetch(`${this.url}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot: this.snapshot, input }),
    });
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: `Server returned ${response.status}` }));
      throw new Error(error.error ?? `Server returned ${response.status}`);
    }
    if (response.headers.get("X-Atlas-Snapshot") !== this.snapshot)
      throw new Error(
        "Server returned a different map snapshot. Reopen the package.",
      );
    if (operation === "offline") {
      const blob = await response.blob();
      return {
        result: blob as T,
        execution: {
          side: "server",
          operation,
          computeMs: Number(response.headers.get("X-Atlas-Compute-Ms")),
          sourceBytes: Number(response.headers.get("X-Atlas-Source-Bytes")),
          responseBytes: blob.size,
        },
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const data = JSON.parse(new TextDecoder().decode(bytes)) as {
      result: T;
      execution: Execution;
    };
    if ((data.result as { snapshot?: string })?.snapshot !== this.snapshot)
      throw new Error("Operation result snapshot mismatch");
    return {
      ...data,
      execution: { ...data.execution, responseBytes: bytes.length },
    };
  }
}
