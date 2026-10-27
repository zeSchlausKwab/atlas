import Ajv, { type ValidateFunction } from "ajv";
import type { AgentTools } from "../../../../packages/chat/src/agent";
import type { ToolDefinition } from "../../../../packages/chat/src/protocol";
import {
  collection,
  drawingBounds,
  type ResultMeta,
} from "../../../../packages/chat/src/geometry";
import {
  objectSchema,
  positionSchema,
} from "../../../../packages/operations/src/registry";
import type { CatalogEntry } from "../../../../packages/operations/src/registry";
import type { AtlasReader } from "../../../../packages/format/src/reader";
import { RoutingComposition } from "../../../../packages/routing/src/composition";
import type { TransportMode } from "../../../../packages/routing/src/index";
import type { WorkspaceMap } from "../../../../packages/renderer/src/workspace-map";
import { WorkerRouter } from "../worker-router";
import { ChatDataClient } from "./data-client";
import { ChatLayers } from "./layers";
const ref = { type: "string", minLength: 1, maxLength: 100 };
const profile = { enum: ["walking", "cycling", "driving"] };
const text = { type: "string", minLength: 1, maxLength: 120 };
const specs: Array<[string, string, Record<string, unknown>]> = [
  [
    "map_context",
    "Get current viewport, selected analysis bounds, compatible datasets, drawing layers and cache state.",
    objectSchema({}),
  ],
  [
    "search",
    "Search explicit addresses or places across selected maps. Returns bounded candidates and point result reference. Resolve ambiguous names before routing.",
    objectSchema(
      { query: text, limit: { type: "integer", minimum: 1, maximum: 10 } },
      ["query"],
    ),
  ],
  [
    "reverse",
    "Find the nearest retained street within 1 km; not house-number reverse geocoding.",
    objectSchema({ point: positionSchema }),
  ],
  [
    "analyze",
    "Compute count, numeric stats (including unknowns), or grouping on a RESULT ID returned by workspace_query (never a workspace ID). Query without filters first to analyze all rows. 'within' filters geometry intersection with ONE polygon from regionResult, e.g. one approximate isochrone. Requires geometry:true for buildings.",
    objectSchema(
      {
        result: ref,
        operation: { enum: ["count", "stats", "group", "within"] },
        field: { type: "string", maxLength: 270 },
        regionResult: ref,
      },
      ["result", "operation"],
    ),
  ],
  [
    "route",
    "Compute a route on this device across compatible selected maps. Coordinates must be resolved, not guessed. Saves geometry as a result reference; call map_draw to show it.",
    objectSchema({ start: positionSchema, end: positionSchema, profile }, [
      "start",
      "end",
      "profile",
    ]),
  ],
  [
    "isochrone",
    "Compute an approximate reachable area on this device. Saves a polygon result reference. Use one band for spatial filtering.",
    objectSchema(
      {
        start: positionSchema,
        profile,
        bands: {
          type: "array",
          items: { type: "integer", minimum: 60, maximum: 1800 },
          minItems: 1,
          maxItems: 4,
        },
      },
      ["start", "profile", "bands"],
    ),
  ],
  [
    "map_draw",
    "Draw a result reference, or a small authored GeoJSON FeatureCollection. Resolves shapes locally without sending them through the model. Returns a removable layer ID.",
    objectSchema(
      {
        result: ref,
        geojson: {
          type: "object",
          description:
            "Small authored drawing only. Use result references for source objects.",
        },
        title: { type: "string", minLength: 1, maxLength: 80 },
        color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      },
      ["title"],
    ),
  ],
  [
    "map_view",
    "Fit the map to a result or drawing layer. Does not change the analysis selection.",
    objectSchema({ result: ref, layer: ref }, []),
  ],
  [
    "map_undo",
    "Remove a specific chat drawing, or the most recent chat layer. Source data and manual tool overlays stay unchanged.",
    objectSchema({ layer: ref }, []),
  ],
];
export class ChatTools implements AgentTools {
  readonly data: ChatDataClient;
  readonly layers: ChatLayers;
  private router?: WorkerRouter;
  private definitionsCache?: ToolDefinition[];
  private validators = new Map<string, ValidateFunction>();
  private progress?: (text: string) => void;
  selectedBounds?: [number, number, number, number];
  constructor(
    readonly map: WorkspaceMap,
    readonly readers: AtlasReader[],
    readonly enabled: () => Set<string>,
    readonly offline: () => boolean,
  ) {
    this.data = new ChatDataClient(readers, offline);
    this.layers = new ChatLayers(map);
    try {
      const composition = new RoutingComposition(
        readers
          .filter((r) => r.index.manifest.transport)
          .map((reader, i) => ({ id: String(i), reader })),
      );
      this.router = new WorkerRouter(
        composition,
        (p) => this.progress?.("Routing · " + p.cells.length + " cells"),
        { searchStates: 2_000_000 },
      );
    } catch {
      /* Capability context explains absent/incompatible graph data. */
    }
  }
  get sourceBytes() {
    return (
      this.data.sourceBytes +
      this.readers.reduce((n, r) => n + r.bytesByPurpose.routing, 0)
    );
  }
  context() {
    return {
      execution: "device",
      viewportBounds: this.map.viewBounds(),
      selectedBounds: this.selectedBounds ?? null,
      zoom: this.map.zoom,
      cacheOnly: this.offline(),
      enabledPurposes: [...this.enabled()],
      datasets: this.readers.map((r) => ({
        name: r.index.manifest.name,
        snapshot: r.index.manifest.snapshot,
        sourceRevision: r.index.manifest.source.sha256,
        bounds: r.index.manifest.bounds,
        capabilities: r.index.manifest.capabilities,
        featureKinds: r.index.manifest.featureKinds,
        semantics: r.index.manifest.semantics,
        featureSchema: r.index.manifest.featureSchema ?? 1,
      })),
      routingAvailable: !!this.router,
      layers: this.layers
        .getSnapshot()
        .map(({ id, title, count, result }) => ({ id, title, count, result })),
      limitations: [
        "Coverage is retained source data, not real-world completeness.",
        "Missing values are unknown.",
        "Map tools execute locally; DeepSeek inference requires internet.",
      ],
    };
  }
  async definitions(signal: AbortSignal) {
    if (this.definitionsCache) return this.definitionsCache;
    const descriptors = (await this.data.call(
      "__catalog",
      {},
      signal,
    )) as CatalogEntry[];
    const definitions: ToolDefinition[] = [
      ...descriptors.map((d) => ({
        type: "function" as const,
        function: {
          name: d.id,
          description: d.description,
          parameters: d.inputSchema,
        },
      })),
      ...specs.map(([name, description, parameters]) => ({
        type: "function" as const,
        function: { name, description, parameters },
      })),
    ];
    const ajv = new Ajv({ strict: false, ownProperties: true });
    for (const d of definitions)
      this.validators.set(d.function.name, ajv.compile(d.function.parameters));
    this.definitionsCache = definitions;
    return definitions;
  }
  async execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
    progress: (text: string) => void = () => {},
  ) {
    signal.throwIfAborted();
    await this.definitions(signal);
    const validate = this.validators.get(name);
    if (!validate || !validate(args))
      throw new Error(
        "Invalid " +
          name +
          " arguments: " +
          JSON.stringify(validate?.errors ?? []).slice(0, 600),
      );
    const i = args as any,
      before = this.sourceBytes,
      started = performance.now();
    const requirePurpose = (p: string) => {
      if (!this.enabled().has(p))
        throw new Error(p + " is disabled in Data settings.");
    };
    if (name === "workspace_prepare")
      for (const f of i.families)
        requirePurpose(f === "locations" ? "search" : "features");
    if (name === "search" || name === "reverse") requirePurpose("search");
    if (name === "route" || name === "isochrone") requirePurpose("routing");
    let result: any;
    if (name === "map_context") result = this.context();
    else if (name === "map_draw") {
      if (!!i.result === !!i.geojson)
        throw new Error("Provide either result or geojson");
      const saved = i.result
        ? await this.data.call("__resolve", { result: i.result }, signal)
        : { collection: i.geojson };
      signal.throwIfAborted();
      result = this.layers.add(saved.collection, i.title, i.color, i.result);
    } else if (name === "map_undo") {
      signal.throwIfAborted();
      result = this.layers.undo(i.layer);
    } else if (name === "map_view") {
      if (!!i.layer === !!i.result)
        throw new Error("Provide either layer or result");
      if (i.layer) {
        signal.throwIfAborted();
        this.layers.fit(i.layer);
      } else {
        const saved = await this.data.call(
          "__resolve",
          { result: i.result },
          signal,
        );
        signal.throwIfAborted();
        this.layers.fitBounds(drawingBounds(saved.collection));
      }
      result = { fitted: i.layer ?? i.result };
    } else if (name === "route" || name === "isochrone") {
      if (!this.router)
        throw new Error(
          "Selected maps do not provide compatible routing graphs",
        );
      this.progress = progress;
      const cancel = () => this.router?.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const r =
          name === "route"
            ? await this.router.route(
                i.start,
                i.end,
                i.profile as TransportMode,
              )
            : await this.router.isochrone(
                i.start,
                i.bands,
                i.profile as TransportMode,
              );
        signal.throwIfAborted();
        const meta: ResultMeta = {
          status: r.status,
          profile: i.profile,
          snapshot: r.snapshot,
          snapshots: this.readers.map((r) => r.index.manifest.snapshot),
          scope: "retained-source-data",
          computeMs: r.computeMs,
          sourceBytes: this.sourceBytes - before,
        };
        if (r.status === "found") {
          Object.assign(meta, {
            meters: r.meters,
            seconds: r.seconds,
            visited: r.visited,
            start: r.start,
            end: r.end,
          });
          result = await this.data.call(
            "__save",
            {
              collection: collection({
                type: "LineString",
                coordinates: r.coordinates,
              }),
              meta,
            },
            signal,
          );
        } else if (r.status === "reachable") {
          Object.assign(meta, {
            approximate: true,
            resolutionMeters: r.resolutionMeters,
            bands: r.contours.features.map((f) => f.properties),
            visited: r.visited,
          });
          result = await this.data.call(
            "__save",
            { collection: r.contours, meta },
            signal,
          );
        } else
          result = {
            ...meta,
            ...("reason" in r ? { reason: r.reason } : {}),
            ...("missing" in r ? { missingCells: r.missing.length } : {}),
          };
      } finally {
        signal.removeEventListener("abort", cancel);
        this.progress = undefined;
      }
    } else result = await this.data.call(name, i, signal);
    signal.throwIfAborted();
    return {
      ...result,
      execution: {
        side: "device",
        computeMs: performance.now() - started,
        sourceBytes: this.sourceBytes - before,
      },
    };
  }
  async clear(signal: AbortSignal) {
    this.layers.clear();
    await this.data.call("__clear", {}, signal);
  }
  destroy() {
    this.router?.cancel();
    this.data.destroy();
    this.layers.destroy();
    this.map.endPicking("chat");
  }
}
