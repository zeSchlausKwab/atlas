import difference from "@turf/difference";
import type { Feature, Polygon } from "geojson";
import {
  MAP_LAYERS,
  TRANSPORT_MODES,
  type Manifest,
} from "../../format/src/index";
import { LEGACY_FEATURE_KINDS } from "../../features/src/index";
import type { PackageSelection } from "./selection";
export const CAPABILITY_CHOICES = [
  ...MAP_LAYERS.map((id) => ({
    id: `tile:${id}`,
    label: `${id[0]!.toUpperCase()}${id.slice(1)} geometry`,
    group: "Map",
  })),
  {
    id: "boundary-display",
    label: "Administrative border outlines",
    group: "Map",
  },
  { id: "labels", label: "Place, street & POI labels", group: "Map" },
  ...TRANSPORT_MODES.map((id) => ({
    id: `routing:${id}`,
    label: `${id[0]!.toUpperCase()}${id.slice(1)} routing & isochrones`,
    group: "Navigation",
  })),
  { id: "search", label: "Place & address search", group: "Analysis" },
  { id: "reverse", label: "Coordinates → nearest street", group: "Analysis" },
  { id: "peaks", label: "Peak queries", group: "Analysis" },
  { id: "features", label: "Feature extraction", group: "Analysis" },
  { id: "boundaries", label: "Administrative boundaries", group: "Analysis" },
  { id: "objects", label: "Tagged objects & relationships", group: "Analysis" },
];
export function installedCapabilities(m: Manifest): string[] {
  return [
    ...(m.rasters ?? []).map((r) => `raster:${r.id}`),
    ...(m.tileLayers ?? []).map((l) => `tile:${l}`),
    ...(m.capabilities.includes("boundary-rendering")
      ? ["boundary-display"]
      : []),
    ...(m.capabilities.includes("map-labels") ? ["labels"] : []),
    ...TRANSPORT_MODES.filter((p) => m.transport?.profiles[p]).map(
      (p) => `routing:${p}`,
    ),
    ...(m.capabilities.includes("location-search") ? ["search"] : []),
    ...(m.capabilities.includes("reverse-street") ? ["reverse"] : []),
    ...(m.capabilities.includes("peak-query") ? ["peaks"] : []),
    ...((m.featureKinds ?? []).some((k) =>
      LEGACY_FEATURE_KINDS.includes(k as any),
    )
      ? ["features"]
      : []),
    ...["boundaries", "objects"].filter((k) =>
      m.featureKinds?.includes(k as any),
    ),
  ];
}
export function blockFamily(key: string): string | undefined {
  if (key.startsWith("raster/")) return `raster:${key.split("/")[1]}`;
  if (key.startsWith("tile/")) return `tile:${key.split("/")[1]}`;
  if (key.startsWith("routing/")) return `routing:${key.split("/")[1]}`;
  if (key.startsWith("labels/")) return "labels";
  if (/^search\/(streets(?:-data)?|street-pages)(?:\/|$)/.test(key))
    return "reverse";
  if (key.startsWith("search/")) return "search";
  if (key.startsWith("features/")) return "features";
  if (key.startsWith("boundary-display/")) return "boundary-display";
  if (key.startsWith("boundaries/")) return "boundaries";
  if (key.startsWith("objects/")) return "objects";
  if (key.startsWith("query/peaks")) return "peaks";
}
export function familySelection(
  m: Manifest,
  families: string[],
  name: string,
  maxBytes: number,
  paddingCells: number,
): PackageSelection {
  const has = (id: string) => families.includes(id);
  return {
    rasters: (m.rasters ?? [])
      .filter((r) => has(`raster:${r.id}`))
      .map((r) => r.id),
    snapshot: m.snapshot,
    name,
    maxBytes,
    paddingCells,
    polygon: m.selection?.polygon ?? [
      [m.bounds[0], m.bounds[1]],
      [m.bounds[2], m.bounds[1]],
      [m.bounds[2], m.bounds[3]],
      [m.bounds[0], m.bounds[3]],
    ],
    minZoom: m.minZoom,
    maxZoom: m.maxZoom,
    layers: MAP_LAYERS.filter((l) => has(`tile:${l}`)),
    profiles: TRANSPORT_MODES.filter((p) => has(`routing:${p}`)),
    placeNames: has("labels"),
    streetNames: has("labels"),
    pois: has("labels"),
    search: has("search"),
    reverse: has("reverse"),
    peaks: has("peaks"),
    featureKinds: [
      ...(has("features") ? LEGACY_FEATURE_KINDS : []),
      ...(has("boundaries") ? ["boundaries" as const] : []),
      ...(has("objects") ? ["objects" as const] : []),
    ],
  };
}
export function pinnedPbfMatches(m: Manifest, sha256: string) {
  return (
    m.source.sha256 === sha256 ||
    !!m.source.inputs?.some(
      (s) => s.sha256 === sha256 && /\.osm\.pbf(?:$|\?)/.test(s.url),
    )
  );
}

/** Bounding boxes alone do not prove polygon coverage (holes/concave selections). */
export function coversCapabilities(
  source: Manifest,
  target: Manifest,
): boolean {
  const shape = (m: Manifest): Feature<Polygon> => {
    const p = m.selection?.polygon ?? [
      [m.bounds[0], m.bounds[1]],
      [m.bounds[2], m.bounds[1]],
      [m.bounds[2], m.bounds[3]],
      [m.bounds[0], m.bounds[3]],
    ];
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[...p, p[0]!]] },
    };
  };
  return !difference({
    type: "FeatureCollection",
    features: [shape(target), shape(source)],
  });
}

export function capabilityChoices(m: Manifest) {
  return [
    ...CAPABILITY_CHOICES,
    ...(m.rasters ?? []).map((r) => ({
      id: `raster:${r.id}`,
      label: r.name,
      group: "Map",
    })),
  ];
}
