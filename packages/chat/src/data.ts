import Ajv from "ajv";
import { analysisSpecs } from "./analysis-specs";
import { AnalysisRecipes, canonical } from "./recipes";
import { thematic } from "./thematic";
import { checkPolygons } from "../../spatial/src/checks";
import type {
  FeatureCollection,
  Feature,
  Polygon,
  MultiPolygon,
} from "geojson";
import { AtlasReader } from "../../format/src/reader";
import { AtlasWorkspace } from "../../workspace/src/index";
import { workspaceTools } from "../../workspace/src/tools";
import { AtlasGeocoder, rankLocations } from "../../geocoding/src/index";
import { normalize, type Location } from "../../geocoding/src/model";
import { placeGeometry } from "./places";
import { OperationRegistry } from "../../operations/src/registry";
import { GeometryResults, validateDrawing, type ResultMeta } from "./geometry";
import {
  spatialOperation,
  property,
  type SpatialInput,
} from "../../spatial/src/index";
import {
  normalizeRows,
  rowFeatures,
  summary,
  filterRows,
  inspectRow,
  prepareChart,
  type ChartInput,
} from "./analysis";
import { distanceBands, constructShape } from "../../spatial/src/construction";
import {
  createField,
  fieldContours,
  type SampledField,
} from "../../spatial/src/fields";
export class ChatDataRuntime {
  private readonly fields = new Map<
    string,
    { field: SampledField; meta: ResultMeta }
  >();
  readonly recipes = new AnalysisRecipes();
  private validators = new Map(
    analysisSpecs.map(([name, , schema]) => [
      name,
      new Ajv({ strict: false, ownProperties: true }).compile(schema),
    ]),
  );
  readonly workspace: AtlasWorkspace;
  readonly results = new GeometryResults();
  readonly registry: OperationRegistry;
  readonly geocoders: AtlasGeocoder[];
  constructor(readonly readers: AtlasReader[]) {
    this.workspace = new AtlasWorkspace(readers, "interactive");
    this.registry = new OperationRegistry(readers[0]!.index.manifest, {
      scanFeatures: () => {
        throw new Error("Use a task workspace");
      },
    });
    for (const plugin of workspaceTools(this.workspace))
      this.registry.register(plugin, "atlas-core-1");
    this.geocoders = readers.map((r) => new AtlasGeocoder(r));
  }
  definitions() {
    return this.registry.catalog();
  }
  snapshot(ref: string) {
    if (ref.startsWith("geo-")) {
      const saved = this.results.get(ref);
      return { rows: saved.collection.features, ...saved };
    }
    return this.workspace.snapshot(ref);
  }
  async resolve(
    ref: string,
  ): Promise<{ collection: FeatureCollection; meta: ResultMeta }> {
    if (ref.startsWith("geo-")) return this.results.get(ref);
    const { rows, meta } = this.workspace.snapshot(ref);
    const collection = rowFeatures(normalizeRows(rows));
    validateDrawing(collection);
    return { collection, meta: { units: { heightMeters: "m" }, ...meta } };
  }
  chart(input: ChartInput) {
    const saved = this.snapshot(input.result);
    return prepareChart(input, normalizeRows(saved.rows), saved.meta);
  }
  select(ref: string, indexes: number[]) {
    const saved = this.snapshot(ref),
      rows = normalizeRows(saved.rows);
    if (
      !Array.isArray(indexes) ||
      indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= rows.length)
    )
      throw new Error("Invalid chart row selection");
    return this.results.save(
      rowFeatures([...new Set(indexes)].map((i) => rows[i]!)),
      {
        operation: "chart_selection",
        inputs: [saved.meta],
        units: (saved.meta as ResultMeta).units,
        sourceResult: ref,
      },
    );
  }
  async invoke(
    name: string,
    input: any,
    signal: AbortSignal,
    progress: (message: string) => void = () => {},
  ) {
    signal.throwIfAborted();
    const start = performance.now(),
      before = this.bytesRead;
    let value: any;
    if (name === "recipe_define") value = this.recipes.define(input);
    else if (name === "recipe_run")
      value = await this.recipes.run(
        input.recipe,
        input.parameters ?? {},
        async (tool, args) => {
          const validate = this.validators.get(tool);
          if (!validate || !validate(args))
            throw new Error(
              `Invalid recipe arguments for ${tool}: ${JSON.stringify(validate?.errors)}`,
            );
          return this.invoke(tool, args, signal, progress);
        },
        signal,
        progress,
      );
    else if (
      name === "result_rows" ||
      (name === "workspace_result" && input.result.startsWith("geo-"))
    ) {
      const saved = this.snapshot(input.result),
        rows = normalizeRows(saved.rows);
      const offset = input.offset ?? 0,
        limit = input.limit ?? 20;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error("Invalid result page");
      if (input.fields?.includes("geometry"))
        throw new Error("Use map_draw; raw geometry stays on the device");
      const page: unknown[] = [];
      let bytes = 0;
      for (const row of rows.slice(offset, offset + limit)) {
        const properties = input.fields
          ? Object.fromEntries(
              input.fields.map((k: string) => [
                k,
                property(row.properties, k) ?? null,
              ]),
            )
          : row.properties;
        const item =
          name === "workspace_result"
            ? { id: row.id, ...properties }
            : {
                id: row.id,
                geometryType: row.geometry?.type ?? null,
                properties,
              };
        const size = new TextEncoder().encode(JSON.stringify(item)).length;
        if (bytes + size > 256 * 1024) {
          if (!page.length)
            throw new Error("Row exceeds page size; select fewer fields");
          break;
        }
        bytes += size;
        page.push(item);
      }
      value = {
        result: input.result,
        rows: page,
        total: rows.length,
        count: rows.length,
        offset,
        nextOffset:
          offset + page.length < rows.length ? offset + page.length : null,
        provenance: saved.meta,
      };
    } else if (name === "result_merge") {
      const entries = new Map<string, Feature>(),
        parents: ResultMeta[] = [];
      for (const ref of input.results) {
        const saved = await this.resolve(ref);
        parents.push(saved.meta);
        for (const feature of saved.collection.features) {
          const id = feature.id ?? feature.properties?.id;
          if (id == null) throw new Error("Merging requires stable source IDs");
          const key = String(id),
            previous = entries.get(key);
          if (previous && canonical(previous) !== canonical(feature))
            throw new Error("Conflicting copies of " + key);
          entries.set(key, feature);
        }
      }
      value = this.results.save(
        { type: "FeatureCollection", features: [...entries.values()] },
        { operation: name, inputs: parents },
      );
    } else if (name === "result_style") {
      const saved = await this.resolve(input.result),
        styled = thematic(saved.collection, input);
      value = this.results.save(styled.collection, {
        operation: name,
        inputs: [saved.meta],
        units: saved.meta.units,
        style: styled.style,
        legend: styled.legend,
        counts: styled.counts,
        unknown: styled.unknown,
        parameters: input,
      });
    } else if (name === "result_check") {
      const saved = await this.resolve(input.result),
        mask = input.excludeResult
          ? await this.resolve(input.excludeResult)
          : undefined;
      const checks = await checkPolygons(
        saved.collection,
        input,
        mask?.collection,
        signal,
        progress,
      );
      value = {
        result: input.result,
        count: saved.collection.features.length,
        checks,
        provenance: saved.meta,
      };
    } else if (name === "spatial_bands" || name === "spatial_shape") {
      const source = input.result
        ? await this.resolve(input.result)
        : undefined;
      if (name === "spatial_bands" && !source)
        throw new Error("Distance bands need a cached source result");
      const mask = input.excludeResult
        ? await this.resolve(input.excludeResult)
        : undefined;
      const result =
        name === "spatial_bands"
          ? await distanceBands(
              input,
              source!.collection,
              signal,
              progress,
              mask?.collection,
            )
          : await constructShape(input, source?.collection, signal, progress);
      signal.throwIfAborted();
      value = this.results.save(result.collection, {
        operation: name,
        parameters: input,
        inputs: [
          ...(source ? [source.meta] : []),
          ...(mask ? [mask.meta] : []),
        ],
        summary: result.summary,
        units: result.units,
        notes: result.notes,
        scope: source ? "derived-from-retained-data" : "authored-geometry",
      });
    } else if (name === "field_create") {
      const source = await this.resolve(input.result);
      const field = await createField(
        input,
        source.collection,
        signal,
        progress,
      );
      const ref = "field-" + crypto.randomUUID();
      const meta: ResultMeta = {
        operation: name,
        parameters: input,
        inputs: [source.meta],
        scope: "derived-from-retained-data",
      };
      signal.throwIfAborted();
      this.fields.set(ref, { field, meta });
      value = { field: ref, ...field.description, provenance: meta };
    } else if (
      name === "field_contours" ||
      name === "field_inspect" ||
      name === "field_release"
    ) {
      const saved = this.fields.get(input.field);
      if (!saved)
        throw new Error("Unknown or released field; create a field first");
      if (name === "field_release") {
        this.fields.delete(input.field);
        value = {
          released: input.field,
          sampleBytesFreed: saved.field.values.byteLength,
        };
      } else if (name === "field_inspect")
        value = {
          field: input.field,
          ...saved.field.description,
          provenance: saved.meta,
        };
      else {
        const result = await fieldContours(
          saved.field,
          input,
          signal,
          progress,
        );
        signal.throwIfAborted();
        value = this.results.save(result.collection, {
          operation: name,
          parameters: input,
          inputs: [saved.meta],
          summary: result.summary,
          units: result.units,
          notes: result.notes,
          field: input.field,
          scope: "derived-from-retained-data",
        });
      }
    } else if (name.startsWith("spatial_")) {
      const source = await this.resolve(input.result),
        target = input.other ? await this.resolve(input.other) : undefined;
      const result = await spatialOperation(
        { ...input, operation: name.slice(8) } as SpatialInput,
        source.collection,
        target?.collection,
        signal,
        progress,
      );
      signal.throwIfAborted();
      if (input.field && (name === "spatial_join" || name === "spatial_grid")) {
        const meta = name === "spatial_join" ? target?.meta : source.meta;
        const unit = (meta?.units as Record<string, string> | undefined)?.[
          input.field
        ];
        if (unit)
          for (const metric of ["sum", "mean", "min", "max"])
            result.units[metric] = unit;
      }
      value = this.results.save(result.collection, {
        operation: name,
        parameters: input,
        inputs: [source.meta, ...(target ? [target.meta] : [])],
        summary: result.summary,
        units: {
          ...((source.meta.units as Record<string, string>) ?? {}),
          ...result.units,
        },
        notes: result.notes,
        scope: "derived-from-retained-data",
      });
    } else if (
      name === "result_filter" ||
      name === "result_summary" ||
      name === "feature_inspect"
    ) {
      const saved = this.snapshot(input.result),
        rows = normalizeRows(saved.rows);
      if (name === "result_summary")
        value = { ...summary(rows, input.field), provenance: saved.meta };
      else if (name === "feature_inspect")
        value = { ...inspectRow(rows, input), provenance: saved.meta };
      else {
        const filtered = filterRows(rows, input);
        value = {
          ...this.results.save(rowFeatures(filtered.rows), {
            operation: name,
            parameters: input,
            inputs: [saved.meta],
            units: (saved.meta as ResultMeta).units,
          }),
          matched: filtered.matched,
          limited: filtered.limited,
        };
      }
    } else if (name.startsWith("workspace_")) {
      if (name === "workspace_result" && input.fields?.includes("geometry"))
        throw new Error(
          "Use map_draw with the result reference; raw geometry is not sent to the model.",
        );
      const d = this.registry.describe(name);
      if (!d) throw new Error("Unknown workspace tool");
      value = await this.registry.invoke(d, input, signal, progress);
    } else if (name === "analyze") {
      let region: Feature<Polygon | MultiPolygon> | undefined;
      let regionMeta: ResultMeta | undefined;
      if (input.operation === "within") {
        const saved = await this.resolve(input.regionResult);
        const shapes = saved.collection.features.filter((f) =>
          ["Polygon", "MultiPolygon"].includes(f.geometry.type),
        );
        if (shapes.length !== 1)
          throw new Error(
            "Spatial region must contain exactly one polygon or multipolygon; request a single isochrone band.",
          );
        region = shapes[0] as Feature<Polygon | MultiPolygon>;
        regionMeta = saved.meta;
      }
      value = this.workspace.analyze({
        result: input.result,
        operation: input.operation,
        field: input.field,
        region,
      });
      if (regionMeta) value = { ...value, region: regionMeta };
    } else if (name === "place_geometry") {
      const saved = this.results.get(input.result);
      if (saved.meta.operation !== "search")
        throw new Error("Pass a search result reference to place_geometry");
      const chosen = saved.collection.features.find((f) => f.id === input.id);
      if (!chosen || chosen.geometry.type !== "Point")
        throw new Error("Choose an ID returned by this search");
      const located = await placeGeometry(
        this.readers,
        chosen,
        input.family ?? "land",
        signal,
        progress,
      );
      value = {
        ...this.results.save(located.collection, {
          operation: "place_geometry",
          input: saved.meta,
          sourceId: input.id,
          scope: "retained-source-data",
          ...located.meta,
        }),
        ...located.meta,
      };
    } else if (name === "search") {
      const matches = new Map<string, Location>();
      const sourceMatchCounts: Array<{
        snapshot: string;
        total: number;
        returned: number;
      }> = [];
      const searched: string[] = [],
        omitted: string[] = [];
      for (let i = 0; i < this.readers.length; i++) {
        signal.throwIfAborted();
        const reader = this.readers[i]!,
          m = reader.index.manifest;
        if (!m.capabilities.includes("location-search")) {
          omitted.push(m.snapshot);
          continue;
        }
        searched.push(m.snapshot);
        const found = await this.geocoders[i]!.search(
          input.query,
          input.limit ?? 8,
          input.tag ? { tag: input.tag } : undefined,
        );
        sourceMatchCounts.push({
          snapshot: m.snapshot,
          total: found.total,
          returned: found.matches.length,
        });
        for (const r of found.matches) {
          const old = matches.get(r.id);
          if (old && canonical(old) !== canonical(r))
            throw new Error("Overlapping search sources disagree on " + r.id);
          matches.set(r.id, r);
        }
      }
      if (!searched.length)
        throw new Error("Selected maps have no search data");
      // Rank the union, rather than filling the final page from the first map.
      const rows = rankLocations(
        [...matches.values()].map((record) => ({
          record,
          names: [record.name, ...record.aliases].map(normalize),
          context: normalize(record.context ?? ""),
        })),
        normalize(input.query),
      )
        .slice(0, input.limit ?? 8)
        .map(({ record: r }) => ({
          id: r.id,
          name: r.name,
          coordinates: r.coordinates,
          kind: r.kind,
          category: r.category,
          address: r.address ?? null,
          context: r.context ?? null,
          tags: r.tags ?? {},
        }));
      const fc: FeatureCollection = {
        type: "FeatureCollection",
        features: rows.map((r) => ({
          type: "Feature",
          id: r.id as string,
          geometry: { type: "Point", coordinates: r.coordinates as number[] },
          properties: { ...r, coordinates: undefined },
        })),
      };
      value = {
        ...this.results.save(fc, {
          operation: "search",
          query: input.query,
          tag: input.tag ?? null,
          snapshots: searched,
          scope: "retained-source-data",
          omittedSources: omitted,
        }),
        matches: rows,
        sourceMatchCounts,
        truncated:
          matches.size > rows.length ||
          sourceMatchCounts.some((s) => s.total > s.returned),
        note: "Candidates ranked across all selected maps, independent of the viewport. Points and their bounds are not place boundaries. Use place_geometry for retained footprints. Candidates may be truncated by source indexes.",
      };
    } else if (name === "reverse") {
      let nearest: any = null;
      const snapshots: string[] = [];
      for (let i = 0; i < this.readers.length; i++) {
        signal.throwIfAborted();
        if (
          !this.readers[i]!.index.manifest.capabilities.includes(
            "reverse-street",
          )
        )
          continue;
        snapshots.push(this.readers[i]!.index.manifest.snapshot);
        const { match } = await this.geocoders[i]!.reverse(input.point);
        if (
          match &&
          (!nearest || match.distanceMeters < nearest.distanceMeters)
        )
          nearest = {
            id: match.id,
            name: match.name,
            coordinates: match.nearest,
            distanceMeters: match.distanceMeters,
          };
      }
      if (!snapshots.length)
        throw new Error("Selected maps have no reverse-street data");
      value = {
        match: nearest,
        snapshots,
        limitMeters: 1000,
        scope: "nearest retained street; not a house-number geocoder",
      };
    } else throw new Error("Unknown data tool");
    signal.throwIfAborted();
    return {
      ...value,
      execution: {
        side: "device",
        computeMs: performance.now() - start,
        sourceBytes: this.bytesRead - before,
      },
    };
  }
  get bytesRead() {
    return (
      this.workspace.bytesRead +
      this.readers.reduce((n, r) => n + r.bytesRead, 0)
    );
  }
  clear() {
    this.recipes.clear();
    this.fields.clear();
    this.workspace.clear();
    this.results.clear();
  }
}
