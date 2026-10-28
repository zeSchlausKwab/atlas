import type { AtlasReader } from "../../format/src/reader";
import {
  objectSchema,
  positionSchema,
  type Plugin,
} from "../../operations/src/registry";
import {
  boundaryLocation,
  boundaryRecords,
  containingBoundaries,
  hasBoundaries,
} from "./index";
import { normalize } from "../../geocoding/src/model";
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export const boundarySpecs: Array<[string, string, Record<string, unknown>]> = [
  [
    "boundary_search",
    "Find retained administrative areas by name across selected datasets, independent of the camera. Returns point candidates with admin_level tags and exact OSM relation/way IDs. Use place_geometry with family=boundaries to obtain the full polygon. Clarify ambiguous candidates; admin_level meanings vary by country.",
    objectSchema(
      {
        query: { type: "string", minLength: 2, maxLength: 120 },
        adminLevel: { type: "string", pattern: "^[0-9]{1,2}$" },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      ["query"],
    ),
  ],
  [
    "boundary_lookup",
    "Find retained administrative polygons containing a longitude/latitude, including holes and islands. Returns geometry for spatial filters and drawing. This is geometric containment, not an inferred administrative hierarchy or a claim of real-world completeness.",
    objectSchema({ point: positionSchema }),
  ],
];
export async function boundaryOperation(
  readers: readonly AtlasReader[],
  name: string,
  input: any,
  signal: AbortSignal,
  progress: (s: string) => void = () => {},
) {
  const available = readers.filter(hasBoundaries),
    snapshots = available.map((r) => r.index.manifest.snapshot),
    omittedSources = readers
      .filter((r) => !hasBoundaries(r))
      .map((r) => r.index.manifest.snapshot);
  if (!available.length)
    throw new Error(
      "Selected maps have no retained administrative boundaries. Upgrade their data; do not infer boundaries from place points.",
    );
  const found = new Map<string, any>();
  for (const r of available) {
    progress(`Reading administrative areas in ${r.index.manifest.name}`);
    if (name === "boundary_search") {
      const q = normalize(input.query);
      if (q.length < 2 || q.length > 120)
        throw new Error("Enter 2–120 searchable characters");
      for await (const row of boundaryRecords(r, undefined, signal, progress)) {
        const location = boundaryLocation(row),
          text = normalize(
            [location.name, ...location.aliases, location.context ?? ""].join(
              " ",
            ),
          );
        if (input.adminLevel && row.tags.admin_level !== input.adminLevel)
          continue;
        if (!q.split(" ").every((t) => text.includes(t))) continue;
        const previous = found.get(row.id);
        if (previous && canonical(previous) !== canonical(location))
          throw new Error(
            "Selected sources disagree on an administrative area",
          );
        found.set(row.id, location);
      }
    } else if (name === "boundary_lookup") {
      for (const f of (await containingBoundaries(r, input.point, signal))
        .features) {
        const previous = found.get(f.id);
        if (previous && canonical(previous) !== canonical(f))
          throw new Error(
            "Selected sources disagree on an administrative boundary",
          );
        found.set(f.id, f);
      }
    } else throw new Error("Unknown boundary operation");
  }
  signal.throwIfAborted();
  const meta = {
    snapshots,
    omittedSources,
    scope: "retained-source-data",
    realWorldCompleteness: "unknown",
    administrativeHierarchy: false,
  };
  if (name === "boundary_search") {
    const rows = [...found.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    return {
      ...meta,
      matches: rows.slice(0, input.limit ?? 10),
      matched: rows.length,
      truncated: rows.length > (input.limit ?? 10),
    };
  }
  return {
    ...meta,
    type: "FeatureCollection" as const,
    features: [...found.values()],
  };
}
export function boundaryTools(readers: readonly AtlasReader[]): Plugin[] {
  return boundarySpecs.map(([id, description, inputSchema]) => ({
    descriptor: {
      id,
      description,
      title:
        id === "boundary_search"
          ? "Find administrative areas"
          : "Administrative containment",
      version: "1.0.0",
      inputSchema,
      outputSchema: { type: "object" },
      requirements: [
        {
          capability: "administrative-boundaries",
          family: "boundaries",
          schema: "boundaries-v1",
        },
      ],
      purposes: ["features"],
      result: id === "boundary_lookup" ? "geojson" : "json",
      execution: ["device", "server"],
      federation: "single-executor",
    },
    available: () => readers.some(hasBoundaries),
    run: (i, c) => boundaryOperation(readers, id, i, c.signal, c.progress),
  }));
}
