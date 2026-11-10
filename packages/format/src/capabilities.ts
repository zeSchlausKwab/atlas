import { familyCatalog } from "./families";
import { TRANSPORT_MODES, type Manifest, type TransportMode } from "./index";
export type RoutingCapability =
  | {
      storage: "cells";
      prefix: string;
      codec: "rcl1" | "rcl2" | "rcl3";
      zoom: number;
    }
  | { storage: "graph"; block: string; codec: "rte1" };
/** One compatibility boundary for transport cells and legacy walking archives. */
export function routingCapability(
  m: Manifest,
  profile: TransportMode,
): RoutingCapability | undefined {
  const p = m.transport?.profiles[profile];
  if (p)
    return { storage: "cells", prefix: p.prefix, codec: p.codec, zoom: p.zoom };
  if (
    profile !== "walking" ||
    !m.capabilities.includes("walking-routing") ||
    !m.routing
  )
    return;
  if (m.routing.cells)
    return {
      storage: "cells",
      prefix: "routing/cells",
      codec: m.routing.cells.codec,
      zoom: m.routing.cells.zoom,
    };
  return { storage: "graph", block: m.routing.block, codec: "rte1" };
}
export interface Dependency {
  family: string;
  schema: string;
  versions: number[];
  optional?: boolean;
  /** Only this travel mode requires this block family. */
  profile?: TransportMode;
}
export interface CapabilityDescription {
  available: boolean;
  dependencies: Dependency[];
  parameters: {
    profiles?: TransportMode[];
    maxBands?: number;
    maxSeconds?: number;
    maxResults?: number;
    maxSpanDegrees?: number;
  };
}
/** Derived catalog v1: no archive migration or duplicate wire metadata required.
 * Coverage describes the source extract, not a promise of route completeness. */
export function operationCatalog(m: Manifest) {
  const routeProfiles = TRANSPORT_MODES.filter((p) => routingCapability(m, p));
  const cellProfiles = routeProfiles.filter(
    (p) => routingCapability(m, p)?.storage === "cells",
  );
  const routing = (profiles: TransportMode[]) =>
    profiles.map((profile) => {
      const p = routingCapability(m, profile)!;
      return {
        profile,
        family: p.storage === "cells" ? p.prefix : p.block,
        schema: p.codec.replace(/\d+$/, ""),
        versions: [Number(p.codec.at(-1))],
      };
    });
  const has = (c: string) => m.capabilities.includes(c);
  const operations = {
    route: {
      available: routeProfiles.length > 0,
      dependencies: routing(routeProfiles),
      parameters: { profiles: routeProfiles },
    },
    isochrone: {
      available: cellProfiles.length > 0,
      dependencies: routing(cellProfiles),
      parameters: { profiles: cellProfiles, maxBands: 4, maxSeconds: 1800 },
    },
    search: {
      available: has("location-search"),
      dependencies: [
        { family: "search/locations", schema: "locations", versions: [1] },
      ],
      parameters: { maxResults: 30 },
    },
    reverse: {
      available: has("reverse-street"),
      dependencies: [
        { family: "search/streets", schema: "streets", versions: [1] },
      ],
      parameters: {},
    },
    peak: {
      available: has("peak-query"),
      dependencies: [{ family: "query/peaks", schema: "peaks", versions: [1] }],
      parameters: {},
    },
    features: {
      available: m.featureZoom !== undefined,
      dependencies: [
        {
          family: "features/{kind}",
          schema: "features",
          versions: [m.featureSchema ?? 1],
        },
      ],
      parameters: { maxResults: 500, maxSpanDegrees: 0.25 },
    },
    offline: {
      available: has("vector-rendering"),
      dependencies: [
        {
          family: "tile/{layer}",
          schema: "til",
          versions: [1, 2],
        },
        {
          family: "routing/walking",
          schema: "rte",
          versions: [1],
          optional: true,
        },
        {
          family: "search/{locations,streets}",
          schema: "json",
          versions: [1],
          optional: true,
        },
        { family: "labels/*", schema: "json", versions: [1], optional: true },
        {
          family: "query/peaks",
          schema: "peaks",
          versions: [1],
          optional: true,
        },
      ],
      parameters: { profiles: m.routing ? ["walking" as const] : [] },
    },
  } satisfies Record<string, CapabilityDescription>;
  return {
    version: 1 as const,
    snapshot: m.snapshot,
    families: familyCatalog(m),
    coverage: {
      bounds: m.bounds,
      polygon: m.selection?.polygon,
      completeness: "source-extract-only" as const,
      boundaryPolicy:
        m.selection?.boundaryPolicy ??
        "retained source objects; external connectivity unknown",
    },
    operations,
  };
}
