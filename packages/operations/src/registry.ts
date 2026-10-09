import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import type { Manifest } from "../../format/src/index";
import type { FeatureQuery, MapFeature } from "../../features/src/index";
export type Schema = Record<string, any>;
export interface Descriptor {
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: Schema;
  outputSchema: Schema;
  requirements: {
    capability?: string;
    family: string;
    schema: string;
    optional?: boolean;
    profile?: string;
  }[];
  purposes: string[];
  result: "json" | "geojson" | "file";
  execution: ("device" | "server")[];
  federation: "single-executor";
  limits?: Record<string, number>;
}
export interface PluginContext {
  manifest: Manifest;
  signal: AbortSignal;
  data: {
    scanFeatures(
      query: FeatureQuery,
      signal?: AbortSignal,
    ): AsyncIterable<MapFeature>;
  };
  progress(message: string): void;
}
export interface Plugin<I = any, O = unknown> {
  descriptor: Descriptor;
  validate?(input: I): void;
  available?(manifest: Manifest): boolean;
  run(input: I, context: PluginContext): Promise<O>;
}
export interface OperationRef {
  id: string;
  version: string;
  implementation: string;
}
export type CatalogEntry = Descriptor & {
  implementation: string;
  enabled: boolean;
  available: boolean;
};
export class OperationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const ajv = new Ajv({ strict: false, allErrors: true, ownProperties: true });
export class OperationRegistry {
  private entries = new Map<
    string,
    {
      plugin: Plugin;
      implementation: string;
      input: ValidateFunction;
      output: ValidateFunction;
    }
  >();
  private disabled = new Set<string>();
  constructor(
    readonly manifest: Manifest,
    private data: PluginContext["data"],
  ) {}
  register(plugin: Plugin, implementation: string) {
    const d = plugin.descriptor;
    if (
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(d.id) ||
      !/^\d+\.\d+\.\d+$/.test(d.version) ||
      !implementation
    )
      throw new Error("Invalid operation identity");
    if (this.entries.has(d.id)) throw new Error(`Duplicate operation: ${d.id}`);
    this.entries.set(d.id, {
      plugin,
      implementation,
      input: ajv.compile(d.inputSchema as AnySchema),
      output: ajv.compile(d.outputSchema as AnySchema),
    });
  }
  setEnabled(id: string, enabled: boolean) {
    if (!this.entries.has(id))
      throw new OperationError("Unknown operation", 404);
    enabled ? this.disabled.delete(id) : this.disabled.add(id);
  }
  get disabledIds() {
    return [...this.disabled].sort();
  }
  catalog(): CatalogEntry[] {
    return [...this.entries.values()].map(({ plugin: p, implementation }) => ({
      ...structuredClone(p.descriptor),
      implementation,
      enabled: !this.disabled.has(p.descriptor.id),
      available:
        p.available?.(this.manifest) ??
        p.descriptor.requirements.every(
          (r) =>
            !r.capability || this.manifest.capabilities.includes(r.capability),
        ),
    }));
  }
  describe(id: string) {
    return this.catalog().find((d) => d.id === id);
  }
  check(ref: OperationRef, input: unknown) {
    const e = this.entries.get(ref.id),
      d = this.describe(ref.id);
    if (!e || !d) throw new OperationError("Unknown operation", 404);
    if (ref.version !== d.version || ref.implementation !== d.implementation)
      throw new OperationError(
        "Operation implementation changed; refresh the catalog.",
        409,
      );
    if (!d.enabled)
      throw new OperationError("This operation is disabled by the host.", 403);
    if (!d.available)
      throw new OperationError(
        "Required data is unavailable in this package.",
        422,
      );
    if (!e.input(input))
      throw new OperationError(
        `Invalid input: ${ajv.errorsText(e.input.errors)}`,
      );
    e.plugin.validate?.(input);
    return e;
  }
  async invoke(
    ref: OperationRef,
    input: unknown,
    signal = new AbortController().signal,
    progress = (_: string) => {},
  ) {
    // Clone before queuing/execution: caller edits cannot change the request identity.
    const request = structuredClone(input),
      e = this.check(ref, request);
    signal.throwIfAborted();
    const result = await e.plugin.run(request, {
      manifest: this.manifest,
      data: {
        scanFeatures: (q) => {
          if (
            !e.plugin.descriptor.requirements.some(
              (r) =>
                r.family === `features/${q.kind}` ||
                r.family === "features/{kind}",
            )
          )
            throw new Error(`Undeclared feature family: ${q.kind}`);
          return this.data.scanFeatures(q, signal);
        },
      },
      signal,
      progress,
    });
    signal.throwIfAborted();
    // Revocation also wins against in-flight work.
    this.check(ref, request);
    if (result instanceof Blob && e.plugin.descriptor.result !== "file")
      throw new Error("Plugin returned an undeclared binary result");
    if (!(result instanceof Blob) && !e.output(result))
      throw new Error(
        `Plugin returned an invalid result: ${ajv.errorsText(e.output.errors)}`,
      );
    return result;
  }
}
export const objectSchema = (
  properties: Schema,
  required = Object.keys(properties),
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const positionSchema: Schema = {
  type: "array",
  items: [
    { type: "number", minimum: -180, maximum: 180 },
    { type: "number", minimum: -85, maximum: 85 },
  ],
  minItems: 2,
  maxItems: 2,
};
export const polygonSchema: Schema = {
  type: "array",
  items: positionSchema,
  minItems: 3,
  maxItems: 128,
};
export const jsonResultSchema: Schema = { type: "object" };
export const featureResultSchema: Schema = {
  type: "object",
  required: [
    "type",
    "features",
    "snapshot",
    "matched",
    "truncated",
    "attribution",
  ],
  properties: {
    type: { const: "FeatureCollection" },
    features: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "id", "bbox", "geometry", "properties"],
        properties: {
          type: { const: "Feature" },
          id: { type: "string" },
          bbox: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4,
          },
          geometry: {
            type: "object",
            required: ["type", "coordinates"],
            properties: {
              type: {
                enum: [
                  "Polygon",
                  "MultiPolygon",
                  "LineString",
                  "MultiLineString",
                ],
              },
              coordinates: { type: "array" },
            },
          },
          properties: {
            type: "object",
            required: ["id", "name", "kind", "tags"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              kind: {
                enum: ["water", "buildings", "land", "roads", "railways"],
              },
              tags: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
          },
        },
      },
    },
    snapshot: { type: "string" },
    matched: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
    attribution: { type: "string" },
  },
};
