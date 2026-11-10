import { objectTools } from "../../objects/src/tools";
import { boundaryTools } from "../../boundaries/src/tools";
import { AtlasWorkspace } from "../../workspace/src/index";
import { workspaceTools } from "../../workspace/src/tools";
import { OperationRegistry } from "./registry";
import { builtins } from "./builtins";
import { operationCatalog } from "../../format/src/capabilities";
import { AtlasReader } from "../../format/src/reader";
import {
  AtlasRouter,
  type Position,
  type TransportMode,
} from "../../routing/src/index";
import { AtlasGeocoder } from "../../geocoding/src/index";
import { AtlasFeatures, type FeatureQuery } from "../../features/src/index";
import { extract, type Selection } from "../../offline/src/index";
import type { Operation, OperationInputs, OperationResults } from "./contract";
export type { Operation, OperationInputs, OperationResults } from "./contract";
export interface Execution {
  side: "device" | "server";
  operation: string;
  computeMs: number;
  sourceBytes: number;
  responseBytes: number;
}
/** Runtime-independent operations. The host supplies WASM initialization and a byte source. */
export class AtlasEngine {
  get capabilities() {
    return operationCatalog(this.reader.index.manifest);
  }
  readonly registry: OperationRegistry;
  readonly workspace: AtlasWorkspace;
  readonly router: AtlasRouter;
  readonly geocoder: AtlasGeocoder;
  readonly features: AtlasFeatures;
  constructor(
    readonly reader: AtlasReader,
    initialize?: () => Promise<unknown>,
    workspaceSources: readonly AtlasReader[] = [reader],
  ) {
    this.workspace = new AtlasWorkspace(workspaceSources);
    this.router = new AtlasRouter(reader, initialize);
    this.geocoder = new AtlasGeocoder(reader);
    this.features = new AtlasFeatures(reader);
    this.registry = new OperationRegistry(reader.index.manifest, {
      scanFeatures: (q, signal) => this.features.scan(q, signal),
    });
    for (const plugin of [
      ...builtins(this),
      ...workspaceTools(this.workspace),
      ...boundaryTools(workspaceSources),
      ...objectTools(workspaceSources),
    ])
      this.registry.register(plugin, "atlas-core-1");
  }
  route(start: Position, end: Position, profile: TransportMode = "walking") {
    return this.router.route(start, end, profile);
  }
  isochrone(
    start: Position,
    bands: number[],
    profile: TransportMode = "walking",
  ) {
    return this.router.isochrone(start, bands, profile);
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
    this.workspace.clear();
  }
}
export class RemoteOperations {
  constructor(
    readonly url: string,
    readonly snapshot: string,
    private adapter?: (path: string, init?: RequestInit) => Promise<Response>,
  ) {}
  request(path: string, init?: RequestInit) {
    return this.adapter
      ? this.adapter(path, init)
      : fetch(`${this.url}${path}`, init);
  }
  async call<K extends Operation>(
    operation: K,
    input: OperationInputs[K],
    signal?: AbortSignal,
  ): Promise<{ result: OperationResults[K]; execution: Execution }> {
    const response = await this.request(`/${operation}`, {
      signal,
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
        result: blob as OperationResults[K],
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
      result: OperationResults[K];
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
