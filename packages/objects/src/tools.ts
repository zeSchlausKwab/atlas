import type { AtlasReader } from "../../format/src/reader";
import { objectSchema, type Plugin } from "../../operations/src/registry";
import {
  findObject,
  hasObjects,
  objectCatalog,
  objectGeometry,
  objectRecords,
  objectTopology,
  type ObjectRecord,
} from "./index";
const id = {
  type: "string",
  pattern:
    "^(?:(node|way|relation)/[0-9]+|external/[a-z0-9-]+/[a-zA-Z0-9_-]+)$",
};
export const objectSpecs: Array<[string, string, Record<string, unknown>]> = [
  [
    "source_catalog",
    "Inspect source retention reports: available object types, tag keys, geometry completeness, relationships and omissions. No geometry reads. Counts describe retained source objects, not real-world completeness.",
    objectSchema({}),
  ],
  [
    "object_search",
    "Find generic retained source objects (sites, trees, entrances, barriers, protected areas, coastline, infrastructure, relations) across selected maps, independent of the viewport. Filter by tag, name or facet; optional bounds explicitly restrict the area. Returns exact identities and attributes, not invented footprints. Use object_get for geometry; use workspace_prepare families:[objects] with where filters for complete local analysis.",
    objectSchema(
      {
        text: { type: "string", minLength: 1 },
        facet: { type: "string" },
        tag: objectSchema(
          { key: { type: "string", minLength: 1 }, value: { type: "string" } },
          ["key"],
        ),
        bounds: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
        },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      [],
    ),
  ],
  [
    "object_get",
    "Load an exact retained object geometry for drawing and spatial analysis. Missing/incomplete geometry is explicitly reported; relations can have members without a polygon. OSM way node IDs retain topology; use object_members to inspect relationships. Real coastlines are lines; extraction edges are not coastlines.",
    objectSchema({ id }, ["id"]),
  ],
  [
    "object_members",
    "Read ordered relation members (including subarea, platform, stop, outer/inner roles) or way node references in pages. A reference is not a guarantee the target is retained. Unavailable source members and geometry status are reported. Untagged coordinate nodes may exist only as way geometry.",
    objectSchema(
      {
        id,
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["id"],
    ),
  ],
];
const canonical = (v: any): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
const summary = (r: ObjectRecord) => ({
  id: r.id,
  name: r.name,
  tags: r.tags,
  facets: r.facets,
  bounds: r.bounds,
  geometryStatus: r.geometryStatus,
  geometryAvailable: !!r.geometry,
  relationshipsAvailable: !!r.topology,
  dependencyOnly: r.dependencyOnly,
});
export async function objectOperation(
  readers: readonly AtlasReader[],
  name: string,
  input: any,
  signal: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  const available = readers.filter(hasObjects),
    meta = {
      scope: "retained-source-data",
      realWorldCompleteness: "unknown",
      snapshots: available.map((r) => r.index.manifest.snapshot),
      omittedSources: readers
        .filter((r) => !hasObjects(r))
        .map((r) => r.index.manifest.snapshot),
    };
  if (name === "source_catalog")
    return {
      ...meta,
      sources: await Promise.all(
        readers.map(async (r) => ({
          name: r.index.manifest.name,
          snapshot: r.index.manifest.snapshot,
          available: hasObjects(r),
          ...(hasObjects(r)
            ? { report: (await objectCatalog(r)).report }
            : { reason: "not-retained-in-this-archive" }),
        })),
      ),
    };
  if (!available.length)
    throw new Error(
      "Selected archives do not retain generic source objects. Upgrade the data before this analysis.",
    );
  const found = new Map<string, { row: ObjectRecord; reader: AtlasReader }>();
  for (const reader of available) {
    const add = (row: ObjectRecord) => {
      const old = found.get(row.id);
      if (old && canonical(summary(old.row)) !== canonical(summary(row)))
        throw new Error(
          "Conflicting source object attributes across selected maps",
        );
      if (!old) found.set(row.id, { row, reader });
    };
    if (name === "object_search") {
      for await (const row of objectRecords(reader, input, signal, progress))
        add(row);
    } else {
      const row = await findObject(reader, input.id, signal);
      if (row) add(row);
    }
  }
  signal.throwIfAborted();
  const matches = [...found.values()].sort((a, b) =>
    a.row.id.localeCompare(b.row.id),
  );
  if (name === "object_search") {
    const offset = input.offset ?? 0,
      limit = input.limit ?? 30;
    return {
      ...meta,
      matches: matches
        .slice(offset, offset + limit)
        .map(({ row }) => summary(row)),
      matched: matches.length,
      offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
    };
  }
  const hit = matches[0];
  if (!hit) return { ...meta, found: false, id: input.id, features: [] };
  if (name === "object_members") {
    const topology = await objectTopology(hit.reader, hit.row, signal),
      items =
        topology.members ??
        (topology.nodeRefs ?? []).map((id: string) => ({
          id: `node/${id}`,
          role: "coordinate",
        })),
      offset = input.offset ?? 0,
      limit = input.limit ?? 100;
    for (const reader of available) {
      if (reader === hit.reader) continue;
      const other = await findObject(reader, hit.row.id, signal);
      if (
        other &&
        canonical(await objectTopology(reader, other, signal)) !==
          canonical(topology)
      )
        throw new Error(
          "Conflicting source object relationships across selected maps",
        );
    }
    return {
      ...meta,
      found: true,
      object: summary(hit.row),
      members: await Promise.all(
        items.slice(offset, offset + limit).map(async (m: any) => ({
          ...m,
          availability:
            m.role === "coordinate"
              ? "coordinate-reference"
              : (topology.unavailableMembers ?? []).includes(m.id)
                ? "missing-in-source"
                : m.coordinates
                  ? "embedded-coordinate"
                  : (
                        await Promise.all(
                          available.map((r) => findObject(r, m.id, signal)),
                        )
                      ).some(Boolean)
                    ? "retained-object"
                    : "reference-only",
        })),
      ),
      total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null,
      unavailableMembers: topology.unavailableMembers ?? [],
    };
  }
  if (name !== "object_get") throw new Error("Unknown source object operation");
  const geometry = await objectGeometry(hit.reader, hit.row, signal);
  // Same identities across a shared snapshot must agree geometrically as well.
  for (const r of available) {
    if (r === hit.reader) continue;
    const other = await findObject(r, hit.row.id, signal);
    if (
      other &&
      canonical(await objectGeometry(r, other, signal)) !== canonical(geometry)
    )
      throw new Error(
        "Conflicting source object geometry across selected maps",
      );
  }
  return {
    ...meta,
    found: true,
    object: summary(hit.row),
    type: "FeatureCollection",
    features: geometry
      ? [
          {
            type: "Feature",
            id: hit.row.id,
            properties: summary(hit.row),
            geometry,
          },
        ]
      : [],
  };
}
export function objectTools(readers: readonly AtlasReader[]): Plugin[] {
  return objectSpecs.map(([id, description, inputSchema]) => ({
    descriptor: {
      id,
      title: id.replaceAll("_", " "),
      version: "1.0.0",
      description,
      inputSchema,
      outputSchema: { type: "object" },
      requirements:
        id === "source_catalog"
          ? []
          : [
              {
                capability: "source-objects",
                family: "objects",
                schema: "source-objects-v1/v2",
              },
            ],
      purposes: ["features"],
      result: id === "object_get" ? "geojson" : "json",
      execution: ["device", "server"],
      federation: "single-executor",
    },
    available: () => id === "source_catalog" || readers.some(hasObjects),
    run: (i, c) => objectOperation(readers, id, i, c.signal, c.progress),
  }));
}
