import type {
  FeatureCollection,
  Feature,
  Polygon,
  MultiPolygon,
} from "geojson";
import { AtlasReader } from "../../format/src/reader";
import { AtlasWorkspace } from "../../workspace/src/index";
import { workspaceTools } from "../../workspace/src/tools";
import { AtlasGeocoder } from "../../geocoding/src/index";
import { OperationRegistry } from "../../operations/src/registry";
import { GeometryResults, validateDrawing, type ResultMeta } from "./geometry";
export class ChatDataRuntime {
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
    const first = this.workspace.result(ref, 0, 1, ["id"]);
    const fc: FeatureCollection = { type: "FeatureCollection", features: [] };
    for (let offset = 0; offset < first.count; offset++) {
      const r = this.workspace.result(ref, offset, 1, [
        "id",
        "family",
        "name",
        "geometry",
        "coordinates",
      ]).rows[0]!;
      const geometry =
        r.geometry ??
        (r.family === "locations"
          ? { type: "Point", coordinates: r.coordinates }
          : null);
      if (!geometry)
        throw new Error(
          "This workspace has no shapes. Prepare with geometry:true before drawing.",
        );
      const f = {
        type: "Feature",
        id: r.id,
        geometry,
        properties: { name: r.name, family: r.family },
      } as unknown as Feature;
      fc.features.push(f);
    }
    validateDrawing(fc);
    return {
      collection: fc,
      meta: {
        result: ref,
        coverage: first.coverage,
        snapshots: first.snapshots,
        expiresAt: first.expiresAt,
      },
    };
  }
  async invoke(name: string, input: any, signal: AbortSignal) {
    signal.throwIfAborted();
    const start = performance.now(),
      before = this.bytesRead;
    let value: any;
    if (name.startsWith("workspace_")) {
      if (name === "workspace_result" && input.fields?.includes("geometry"))
        throw new Error(
          "Use map_draw with the result reference; raw geometry is not sent to the model.",
        );
      const d = this.registry.describe(name);
      if (!d) throw new Error("Unknown workspace tool");
      value = await this.registry.invoke(d, input, signal);
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
    } else if (name === "search") {
      const matches = new Map<string, Record<string, unknown>>();
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
        );
        sourceMatchCounts.push({
          snapshot: m.snapshot,
          total: found.total,
          returned: found.matches.length,
        });
        for (const r of found.matches) {
          const row = {
            id: r.id,
            name: r.name,
            coordinates: r.coordinates,
            kind: r.kind,
            category: r.category,
            address: r.address ?? null,
          };
          const old = matches.get(r.id);
          if (old && JSON.stringify(old) !== JSON.stringify(row))
            throw new Error("Overlapping search sources disagree on " + r.id);
          matches.set(r.id, row);
        }
      }
      if (!searched.length)
        throw new Error("Selected maps have no search data");
      const rows = [...matches.values()].slice(0, input.limit ?? 8);
      const fc: FeatureCollection = {
        type: "FeatureCollection",
        features: rows.map((r) => ({
          type: "Feature",
          id: r.id as string,
          geometry: { type: "Point", coordinates: r.coordinates as number[] },
          properties: { name: r.name },
        })),
      };
      value = {
        ...this.results.save(fc, {
          snapshots: searched,
          scope: "retained-source-data",
          omittedSources: omitted,
        }),
        matches: rows,
        sourceMatchCounts,
        truncated:
          matches.size > rows.length ||
          sourceMatchCounts.some((s) => s.total > s.returned),
        note: "Bounded candidates per source; not a globally exhaustive ranking.",
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
    this.workspace.clear();
    this.results.clear();
  }
}
