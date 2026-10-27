import booleanIntersects from "@turf/boolean-intersects";
import difference from "@turf/difference";
import type { Feature, Polygon, MultiPolygon, Geometry } from "geojson";
import { AtlasReader } from "../../format/src/reader";
import { project, type Block } from "../../format/src/index";
import { type Bounds } from "../../features/src/index";
import { readFeatureCell, geometryHash } from "../../features/src/pages";
import { locations } from "../../geocoding/src/index";
import { normalize, type Address } from "../../geocoding/src/model";
import { STREET_ZOOM } from "../../geocoding/src/paging";
import { buildingHeight } from "../../format/src/heights";
import { describeData, FAMILIES, supports, type Family } from "./catalog";
export { describeData } from "./catalog";
export type { Family } from "./catalog";
const MiB = 1024 ** 2;
const TTL = 30 * 60 * 1000;
export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsupported_data"
      | "outside_coverage"
      | "missing_blocks"
      | "budget_exceeded"
      | "conflicting_data"
      | "expired_reference",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}
export interface Prepare {
  bounds: Bounds;
  families: Family[];
  /** false pins attributes only; geometry may still be read for exact boundary checks. */
  geometry?: boolean;
  required?: ("addresses" | "poi-tags")[];
  cacheOnly?: boolean;
  allowPartial?: boolean;
  maxReadBytes?: number;
  maxMemoryBytes?: number;
}
export interface Filter {
  field: string;
  op: "eq" | "exists" | "gte" | "lte" | "contains";
  value?: string | number | boolean;
}
export interface Query {
  workspace: string;
  from?: string;
  ids?: string[];
  text?: string;
  where?: Filter[];
}
interface Row {
  id: string;
  family: Family;
  name: string;
  kind: string;
  category: string;
  coordinates?: [number, number];
  address?: Address;
  tags: Record<string, string>;
  heightMeters: number | null;
  heightSource: "tagged" | "levels-estimate" | "unknown";
  geometry?: Geometry;
  geometryHash?: string;
  aliases?: string[];
  context?: string;
}
interface Coverage {
  status: "complete" | "partial";
  scope: "retained-source-data";
  realWorldCompleteness: "unknown";
  requested: Bounds;
  requirements: ("addresses" | "poi-tags")[];
  families: {
    family: Family;
    status: "complete" | "outside_coverage" | "unsupported_data";
  }[];
}
interface Workspace {
  id: string;
  expiresAt: number;
  rows: Row[];
  coverage: Coverage;
  snapshots: string[];
  memoryEstimateBytes: number;
  readBytes: number;
}
interface Result {
  workspace: string;
  indexes: number[];
}
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
function boundsValid(b: Bounds, interactive = false) {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every(Number.isFinite) &&
    b[0] < b[2] &&
    b[1] < b[3] &&
    b[0] >= -180 &&
    b[2] <= 180 &&
    b[1] >= -85 &&
    b[3] <= 85 &&
    (interactive || (b[2] - b[0] <= 0.25 && b[3] - b[1] <= 0.25))
  );
}
function rect(b: Bounds): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [b[0], b[1]],
          [b[2], b[1]],
          [b[2], b[3]],
          [b[0], b[3]],
          [b[0], b[1]],
        ],
      ],
    },
  };
}
function covers(readers: AtlasReader[], bounds: Bounds) {
  let rest: Feature<Polygon | MultiPolygon> | null = rect(bounds);
  for (const r of readers) {
    if (!rest) return true;
    const m = r.index.manifest,
      polygon = m.selection?.polygon;
    const region: Feature<Polygon> = polygon
      ? {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[...polygon, polygon[0]!]],
          },
        }
      : rect(m.bounds);
    rest = difference({ type: "FeatureCollection", features: [rest, region] });
  }
  return !rest;
}
const fields = new Set([
  "id",
  "family",
  "name",
  "kind",
  "category",
  "coordinates",
  "heightMeters",
  "heightSource",
  "geometry",
  "geometryAvailable",
  "address",
  "tags",
  "context",
]);
function fieldValid(f: string) {
  return (
    fields.has(f) ||
    /^(tags\.[\w:.-]{1,256}|address\.(houseNumber|street|place|city|postcode|country|source))$/.test(
      f,
    )
  );
}
function field(row: Row, f: string): unknown {
  if (f === "geometryAvailable") return row.geometry !== undefined;
  if (f.startsWith("tags."))
    return Object.hasOwn(row.tags, f.slice(5)) ? row.tags[f.slice(5)] : null;
  if (f.startsWith("address."))
    return row.address?.[f.slice(8) as keyof Address] ?? null;
  return row[f as keyof Row] ?? null;
}
/** Task-local, pinned data and opaque results. No network access occurs during query/result. */
export class AtlasWorkspace {
  private workspaces = new Map<string, Workspace>();
  private results = new Map<string, Result>();
  private preparing = false;
  private lifetime = new AbortController();
  bytesRead = 0;
  constructor(
    readonly readers: readonly AtlasReader[],
    readonly policy: "bounded" | "interactive" = "bounded",
  ) {
    if (
      !readers.length ||
      (this.policy === "bounded" && readers.length > 8) ||
      readers.some((r) => !r.index)
    )
      throw new WorkspaceError(
        "invalid_request",
        this.policy === "interactive"
          ? "Open at least one source first."
          : "Open 1–8 sources first.",
      );
  }
  catalog() {
    return this.readers.map((r) => describeData(r.index.manifest));
  }
  private sweep() {
    for (const [id, w] of this.workspaces)
      if (Date.now() >= w.expiresAt) this.release(id);
  }
  private workspace(id: string) {
    this.sweep();
    const w = this.workspaces.get(id);
    if (!w)
      throw new WorkspaceError(
        "expired_reference",
        "Workspace expired or was released; prepare it again.",
      );
    return w;
  }
  async prepare(input: Prepare, signal = new AbortController().signal) {
    this.sweep();
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    const p = structuredClone(input);
    const interactive = this.policy === "interactive";
    const maxRead = p.maxReadBytes ?? (interactive ? Infinity : 32 * MiB),
      maxMemory = p.maxMemoryBytes ?? (interactive ? Infinity : 64 * MiB);
    if (
      !boundsValid(p.bounds, interactive) ||
      (p.geometry !== undefined && typeof p.geometry !== "boolean") ||
      !Array.isArray(p.families) ||
      !p.families.length ||
      p.families.length > FAMILIES.length ||
      p.families.some((f) => !FAMILIES.includes(f)) ||
      [maxRead, maxMemory].some(
        (n) =>
          !(interactive && n === Infinity) &&
          (!Number.isSafeInteger(n) || n < 1 || (!interactive && n > 64 * MiB)),
      )
    )
      throw new WorkspaceError(
        "invalid_request",
        interactive
          ? "Choose valid geographic bounds and supported families."
          : "Choose a box up to 0.25° across, supported families, and budgets of 1–67108864 bytes.",
      );
    if (this.preparing || (!interactive && this.workspaces.size >= 2))
      throw new WorkspaceError(
        "budget_exceeded",
        this.preparing
          ? "Another workspace is being prepared; wait for it to finish."
          : "Release a workspace before preparing another (two active workspaces maximum).",
      );
    const families = [...new Set(p.families)];
    if (
      p.required &&
      (!families.includes("locations") ||
        !Array.isArray(p.required) ||
        p.required.length > 2 ||
        p.required.some((r) => !["addresses", "poi-tags"].includes(r)))
    )
      throw new WorkspaceError(
        "invalid_request",
        "Semantic requirements apply to locations: addresses and poi-tags.",
      );
    const eligible = (r: AtlasReader, family: Family) =>
      supports(r.index.manifest, family) &&
      (family !== "locations" ||
        (p.required ?? []).every((requirement) =>
          requirement === "addresses"
            ? r.index.manifest.semantics?.addresses === "osm-explicit"
            : r.index.manifest.semantics?.poiTags === true,
        ));
    const coverage: Coverage = {
      status: "complete",
      scope: "retained-source-data",
      realWorldCompleteness: "unknown",
      requested: p.bounds,
      requirements: p.required ?? [],
      families: families.map((family) => {
        const providers = this.readers.filter((r) => eligible(r, family));
        return {
          family,
          status: !providers.length
            ? "unsupported_data"
            : covers(providers, p.bounds)
              ? "complete"
              : "outside_coverage",
        };
      }),
    };
    const gap = coverage.families.find((f) => f.status !== "complete");
    if (gap) {
      coverage.status = "partial";
      if (!p.allowPartial)
        throw new WorkspaceError(
          gap.status as "unsupported_data" | "outside_coverage",
          "Requested coverage is unavailable; add a source or explicitly allow a partial workspace.",
          { coverage },
        );
    }
    const revisions = new Set(
      this.readers.map((r) => r.index.manifest.source.sha256),
    );
    const parents = new Set(
      this.readers.map(
        (r) =>
          r.index.manifest.selection?.parentSnapshot ??
          r.index.manifest.snapshot,
      ),
    );
    if (revisions.size > 1 && parents.size > 1)
      throw new WorkspaceError(
        "conflicting_data",
        "Composition requires a shared source revision or parent snapshot.",
      );
    this.preparing = true;
    let readBytes = 0,
      memoryEstimateBytes = 0;
    const rows = new Map<string, Row>(),
      identities = new Map<string, string>();
    const charged = new Set<string>();
    const active: AtlasReader[] = [];
    try {
      for (const base of this.readers) {
        signal.throwIfAborted();
        const m = base.index.manifest;
        const reader = base.fork(
          {
            purposes: ["features", "search"],
            cacheBudgets: {
              map: 0,
              routing: 0,
              labels: 0,
              semantic: 8 * MiB,
              directory: 0,
            },
            directoryBudget: MiB,
            beforeBlock: (b: Block) => {
              signal.throwIfAborted();
              const key = `${m.snapshot}:${b.key}`;
              if (charged.has(key)) return;
              // Covers encoded buffers plus conservative JS parse overhead, not a hard RSS guarantee.
              const estimate = (b.rawLength ?? b.length) * 5;
              if (memoryEstimateBytes + estimate > maxMemory)
                throw new WorkspaceError(
                  "budget_exceeded",
                  "Data exceeds the workspace memory estimate; choose a smaller area or fewer families.",
                  {
                    memoryEstimateBytes,
                    nextBlockEstimateBytes: estimate,
                    maxMemoryBytes: maxMemory,
                  },
                );
              memoryEstimateBytes += estimate;
              charged.add(key);
            },
          },
          {
            read: async (start, end, abort) => {
              signal.throwIfAborted();
              if (p.cacheOnly)
                throw new WorkspaceError(
                  "missing_blocks",
                  "Workspace needs uncached data; allow fetching or choose cached coverage.",
                );
              if (readBytes + end - start > maxRead)
                throw new WorkspaceError(
                  "budget_exceeded",
                  "Workspace read budget exceeded; narrow the area or increase the budget.",
                  {
                    readBytes,
                    nextReadBytes: end - start,
                    maxReadBytes: maxRead,
                  },
                );
              readBytes += end - start;
              this.bytesRead += end - start;
              return base.source.read(
                start,
                end,
                AbortSignal.any([signal, ...(abort ? [abort] : [])]),
              );
            },
          },
        );
        reader.offline = p.cacheOnly === true || base.offline;
        active.push(reader);
        const add = (row: Row) => {
          const key = `${row.family}:${row.id}`,
            previous = rows.get(key);
          // Source-context labels may differ at extract borders. Source attributes and geometry may not.
          const signature = canonical({
            ...row,
            context: undefined,
            aliases: undefined,
          });
          if (previous && identities.get(key) !== signature)
            throw new WorkspaceError(
              "conflicting_data",
              "Overlapping sources disagree on an object; use compatible snapshots.",
              { id: row.id, family: row.family },
            );
          if (!previous) {
            if (!interactive && rows.size >= 100000)
              throw new WorkspaceError(
                "budget_exceeded",
                "Workspace exceeds 100,000 records; choose a smaller area.",
              );
            rows.set(key, row);
            identities.set(key, signature);
          }
        };
        for (const family of families) {
          if (!eligible(base, family)) continue;
          const n =
            2 ** (family === "locations" ? STREET_ZOOM : m.featureZoom!);
          const nw = project(p.bounds[0], p.bounds[3]),
            se = project(p.bounds[2], p.bounds[1]);
          let keys: string[];
          if (family === "locations") {
            const root = JSON.parse(
              new TextDecoder().decode(await reader.block("search/locations")),
            );
            keys =
              root.schema === "locations-paged-v1"
                ? (
                    await reader.spatial(
                      "search/locations-data",
                      STREET_ZOOM,
                      Math.floor(nw[0] * n),
                      Math.floor(se[0] * n),
                      Math.floor(nw[1] * n),
                      Math.floor(se[1] * n),
                    )
                  ).map((b) => b.key)
                : ["search/locations"];
          } else
            keys = (
              await reader.spatial(
                `features/${family}`,
                m.featureZoom!,
                Math.floor(nw[0] * n),
                Math.floor(se[0] * n),
                Math.floor(nw[1] * n),
                Math.floor(se[1] * n),
              )
            ).map((b) => b.key);
          for (const key of keys) {
            signal.throwIfAborted();
            if (family === "locations") {
              const bytes = await reader.block(key);
              for (const { record: r } of locations(bytes)) {
                const [x, y] = r.coordinates;
                if (
                  x < p.bounds[0] ||
                  x > p.bounds[2] ||
                  y < p.bounds[1] ||
                  y > p.bounds[3]
                )
                  continue;
                add({
                  ...r,
                  family,
                  tags: r.tags ?? {},
                  heightMeters: null,
                  heightSource: "unknown",
                });
              }
            } else
              for await (const f of readFeatureCell(
                reader,
                key,
                p.bounds,
                p.geometry !== false,
                signal,
              )) {
                if (f.properties.kind !== family) continue;
                const h = buildingHeight(f.properties.tags);
                add({
                  id: f.id,
                  family,
                  name: f.properties.name,
                  kind: family,
                  category: family,
                  tags: f.properties.tags,
                  geometry: f.geometry,
                  geometryHash:
                    f.geometryHash ??
                    (f.geometry ? await geometryHash(f.geometry) : undefined),
                  heightMeters:
                    family === "buildings" && h.height >= 0 ? h.height : null,
                  heightSource:
                    family !== "buildings" || (h.source & 3) === 0
                      ? "unknown"
                      : (h.source & 3) === 1
                        ? "tagged"
                        : "levels-estimate",
                });
              }
          }
        }
      }
      signal.throwIfAborted();
      const w: Workspace = {
        id: crypto.randomUUID(),
        expiresAt: interactive ? Number.MAX_SAFE_INTEGER : Date.now() + TTL,
        rows: [...rows.values()].sort((a, b) =>
          `${a.family}:${a.id}`.localeCompare(`${b.family}:${b.id}`),
        ),
        coverage,
        snapshots: this.readers.map((r) => r.index.manifest.snapshot),
        memoryEstimateBytes,
        readBytes,
      };
      this.workspaces.set(w.id, w);
      return structuredClone({
        workspace: w.id,
        expiresAt: w.expiresAt,
        records: w.rows.length,
        coverage,
        snapshots: w.snapshots,
        readBytes,
        memoryEstimateBytes,
        pinned: true,
      });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Not cached:"))
        throw new WorkspaceError("missing_blocks", e.message, {
          cacheOnly: true,
        });
      throw e;
    } finally {
      this.preparing = false;
      for (const r of active) r.dispose();
    }
  }
  /** Local-only full snapshot for code execution; never returned by workspace_result. */
  snapshot(ref: string) {
    const first = this.result(ref, 0, 1, ["id"]);
    const result = this.results.get(ref)!;
    const w = this.workspace(result.workspace);
    return {
      rows: structuredClone(result.indexes.map((i) => w.rows[i]!)),
      meta: {
        result: ref,
        coverage: first.coverage,
        snapshots: first.snapshots,
        expiresAt: first.expiresAt,
      },
    };
  }
  query(input: Query) {
    const start = performance.now(),
      w = this.workspace(input.workspace);
    if (
      this.policy === "bounded" &&
      ((input.text?.length ?? 0) > 120 ||
        (input.ids?.length ?? 0) > 500 ||
        (input.where?.length ?? 0) > 20)
    )
      throw new WorkspaceError(
        "invalid_request",
        "Query limits: 120 text characters, 500 IDs, 20 filters.",
      );
    for (const f of input.where ?? [])
      if (
        !fieldValid(f.field) ||
        !["eq", "exists", "gte", "lte", "contains"].includes(f.op) ||
        (f.op === "exists"
          ? typeof f.value !== "boolean"
          : f.op === "gte" || f.op === "lte"
            ? typeof f.value !== "number" || !Number.isFinite(f.value)
            : !["string", "number", "boolean"].includes(typeof f.value))
      )
        throw new WorkspaceError("invalid_request", "Invalid typed filter.");
    const parent = input.from ? this.results.get(input.from) : undefined;
    if (input.from && (!parent || parent.workspace !== w.id))
      throw new WorkspaceError(
        "expired_reference",
        "Result is absent or belongs to another workspace.",
      );
    if (this.policy === "bounded" && this.results.size >= 64)
      throw new WorkspaceError(
        "budget_exceeded",
        "Release a workspace to free result handles (64 maximum).",
      );
    const ids = input.ids ? new Set(input.ids) : undefined,
      tokens = normalize(input.text ?? "")
        .split(" ")
        .filter(Boolean);
    const indexes = (parent?.indexes ?? w.rows.map((_, i) => i)).filter((i) => {
      const r = w.rows[i]!;
      if (ids && !ids.has(r.id)) return false;
      const text = normalize(
        [r.name, ...(r.aliases ?? []), r.context ?? ""].join(" "),
      );
      if (!tokens.every((t) => text.includes(t))) return false;
      return (input.where ?? []).every((f) => {
        const value = field(r, f.field);
        if (f.op === "exists") return (value !== null) === f.value;
        if (value === null) return false;
        if (f.op === "eq") return value === f.value;
        if (f.op === "contains")
          return (
            typeof value === "string" &&
            typeof f.value === "string" &&
            normalize(value).includes(normalize(f.value))
          );
        return (
          typeof value === "number" &&
          (f.op === "gte"
            ? value >= (f.value as number)
            : value <= (f.value as number))
        );
      });
    });
    const resultBytes = [...this.results.values()].reduce(
      (n, r) => n + r.indexes.length * 8,
      indexes.length * 8,
    );
    if (this.policy === "bounded" && resultBytes > 8 * MiB)
      throw new WorkspaceError(
        "budget_exceeded",
        "Result references exceed 8 MiB; release a workspace.",
      );
    const result = crypto.randomUUID();
    this.results.set(result, { workspace: w.id, indexes });
    return {
      result,
      workspace: w.id,
      count: indexes.length,
      coverage: structuredClone(w.coverage),
      snapshots: [...w.snapshots],
      expiresAt: w.expiresAt,
      computeMs: performance.now() - start,
      sourceBytes: 0,
      preview: this.result(result, 0, 5).rows,
    };
  }
  result(
    ref: string,
    offset = 0,
    limit = 20,
    projection = [
      "id",
      "family",
      "name",
      "kind",
      "coordinates",
      "heightMeters",
    ],
  ) {
    this.sweep();
    const result = this.results.get(ref);
    if (!result)
      throw new WorkspaceError(
        "expired_reference",
        "Result expired, was released or is unknown.",
      );
    const w = this.workspace(result.workspace);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      (this.policy === "bounded" && limit > 100) ||
      projection.length < 1 ||
      (this.policy === "bounded" && projection.length > 30) ||
      projection.some((f) => !fieldValid(f))
    )
      throw new WorkspaceError(
        "invalid_request",
        "Use a nonnegative offset, 1–100 rows and 1–30 known fields.",
      );
    const rows = result.indexes
      .slice(offset, offset + limit)
      .map((i) =>
        Object.fromEntries(projection.map((f) => [f, field(w.rows[i]!, f)])),
      );
    if (
      this.policy === "bounded" &&
      new TextEncoder().encode(JSON.stringify(rows)).length > 256 * 1024
    )
      throw new WorkspaceError(
        "budget_exceeded",
        "Result page exceeds 256 KiB; request fewer rows or omit geometry/tags.",
      );
    return {
      result: ref,
      count: result.indexes.length,
      rows: structuredClone(rows),
      nextOffset:
        offset + rows.length < result.indexes.length
          ? offset + rows.length
          : null,
      coverage: structuredClone(w.coverage),
      snapshots: [...w.snapshots],
      expiresAt: w.expiresAt,
    };
  }
  /** Deterministic statistics or spatial filtering of already pinned rows; no reads. */
  analyze(input: {
    result: string;
    operation: "count" | "stats" | "group" | "within";
    field?: string;
    region?: Feature<Polygon | MultiPolygon>;
  }) {
    this.sweep();
    const source = this.results.get(input.result);
    if (!source)
      throw new WorkspaceError(
        "expired_reference",
        "Result is unknown or expired.",
      );
    const w = this.workspace(source.workspace),
      started = performance.now();
    const evidence = {
      result: input.result,
      count: source.indexes.length,
      coverage: structuredClone(w.coverage),
      snapshots: [...w.snapshots],
      expiresAt: w.expiresAt,
      sourceBytes: 0,
    };
    if (input.operation === "count") return evidence;
    if (input.operation === "within") {
      if (
        !input.region ||
        !["Polygon", "MultiPolygon"].includes(input.region.geometry.type)
      )
        throw new WorkspaceError(
          "invalid_request",
          "Spatial filter requires a polygon result.",
        );
      const indexes = source.indexes.filter((i) => {
        const row = w.rows[i]!;
        const geometry =
          row.geometry ??
          (row.family === "locations"
            ? { type: "Point" as const, coordinates: row.coordinates }
            : undefined);
        if (!geometry)
          throw new WorkspaceError(
            "unsupported_data",
            "Prepare with geometry:true for spatial filtering.",
          );
        return booleanIntersects(
          { type: "Feature", geometry, properties: {} },
          input.region!,
        );
      });
      const bytes = [...this.results.values()].reduce(
        (n, r) => n + r.indexes.length * 8,
        indexes.length * 8,
      );
      if (
        this.policy === "bounded" &&
        (this.results.size >= 64 || bytes > 8 * MiB)
      )
        throw new WorkspaceError(
          "budget_exceeded",
          "Result budget reached; release a workspace.",
        );
      const result = crypto.randomUUID();
      this.results.set(result, { workspace: w.id, indexes });
      return {
        ...evidence,
        result,
        workspace: w.id,
        count: indexes.length,
        method: "geometry-intersects; locations use retained anchors",
        computeMs: performance.now() - started,
        preview: this.result(result, 0, 5).rows,
      };
    }
    if (
      !input.field ||
      !fieldValid(input.field) ||
      ["geometry", "tags", "address"].includes(input.field)
    )
      throw new WorkspaceError("invalid_request", "Choose a scalar field.");
    const values = source.indexes.map((i) => field(w.rows[i]!, input.field!));
    if (input.operation === "stats") {
      let known = 0,
        unknown = 0,
        min = Infinity,
        max = -Infinity,
        sum = 0;
      for (const value of values) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          unknown++;
          continue;
        }
        known++;
        sum += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return {
        ...evidence,
        field: input.field,
        known,
        unknown,
        min: known ? min : null,
        max: known ? max : null,
        sum: known ? sum : null,
        mean: known ? sum / known : null,
        units: input.field === "heightMeters" ? "metres" : "field units",
        computeMs: performance.now() - started,
      };
    }
    if (input.operation !== "group")
      throw new WorkspaceError(
        "invalid_request",
        "Unknown analysis operation.",
      );
    const groups = new Map<string, { value: unknown; count: number }>();
    for (const value of values) {
      if (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      )
        throw new WorkspaceError(
          "invalid_request",
          "Grouping requires a scalar field.",
        );
      const key = JSON.stringify(value);
      const group = groups.get(key) ?? { value, count: 0 };
      group.count++;
      groups.set(key, group);
      if (this.policy === "bounded" && groups.size > 1000)
        throw new WorkspaceError(
          "budget_exceeded",
          "Too many distinct groups; choose another field.",
        );
    }
    return {
      ...evidence,
      field: input.field,
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
      unknown: values.filter((v) => v === null).length,
      computeMs: performance.now() - started,
    };
  }
  release(id: string) {
    const released = this.workspaces.delete(id);
    for (const [ref, result] of this.results)
      if (result.workspace === id) this.results.delete(ref);
    return { released };
  }
  clear() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.workspaces.clear();
    this.results.clear();
  }
}
