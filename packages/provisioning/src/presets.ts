/** Shared, declarative recipes. Applying a preset never starts a build. */
export interface PreparationPreset {
  id: string;
  label: string;
  group: "World" | "Your area";
  description: string;
  fields: readonly string[] | "all";
  maxZoom: number;
  world?: boolean;
  boundaryMaxAdminLevel?: number;
}
const geometry = [
  "layer-land",
  "layer-water",
  "layer-roads",
  "layer-railways",
  "layer-buildings",
  "layer-peaks",
  "ocean",
];
const display = [...geometry, "places", "streets", "pois"];
export const PREPARATION_PRESETS: readonly PreparationPreset[] = [
  {
    id: "world-overview",
    label: "World · country overview",
    group: "World",
    world: true,
    maxZoom: 6,
    boundaryMaxAdminLevel: 2,
    fields: ["layer-water", "ocean", "places", "feature-boundaries"],
    description:
      "A lightweight base for country comparisons and choropleths: countries, place labels, lakes, rivers and sea fill at z0–6. Boundary polygons are available to analysis and drawing tools; they are not a styled border overlay. No routing or object archive.",
  },
  {
    id: "world-admin",
    label: "World · information visualization",
    group: "World",
    world: true,
    maxZoom: 6,
    boundaryMaxAdminLevel: 10,
    fields: ["layer-water", "ocean", "places", "feature-boundaries"],
    description:
      "Countries, regions and local administrative areas through OSM level 10, plus place labels and water at z0–6. A compact selection of families, not a fixed small file: worldwide local boundaries can occupy several GiB. Polygons retain their original detail for analysis and drawing. Municipality levels and coverage vary by country.",
  },
  {
    id: "world-geometry",
    label: "World · full display geometry",
    group: "World",
    world: true,
    maxZoom: 16,
    fields: geometry,
    description:
      "All six display layers and sea fill across the world at z0–16. No labels, routing, search or extractable source features. Full world means the supported map extent, 85°S–85°N. This is a major build even without routing; check temporary space as well as final size.",
  },
  {
    id: "view",
    label: "Map display · geometry & labels",
    group: "Your area",
    maxZoom: 16,
    fields: display,
    description:
      "A detailed visual map with place, street and POI labels. Routing, search and feature extraction stay off.",
  },
  {
    id: "overview",
    label: "Regional overview · light display",
    group: "Your area",
    maxZoom: 10,
    fields: ["layer-land", "layer-water", "layer-roads", "ocean", "places"],
    description:
      "Landscape, water, roads and place labels at z0–10. Suitable for regional context without detailed building tiles.",
  },
  {
    id: "geometry",
    label: "Geometry only",
    group: "Your area",
    maxZoom: 16,
    fields: geometry,
    description:
      "Display geometry only, without labels, routing, search or extractable source features.",
  },
  {
    id: "boundaries",
    label: "Administrative analysis · areas & places",
    group: "Your area",
    maxZoom: 8,
    boundaryMaxAdminLevel: 10,
    fields: ["feature-boundaries", "places", "layer-water", "ocean"],
    description:
      "Country, regional and local administrative polygons for comparisons and drawing, with place labels and a water backdrop. Administrative levels differ by country. Population statistics and other external indicators are not included.",
  },
  {
    id: "walking",
    label: "Walking & cycling · map & routes",
    group: "Your area",
    maxZoom: 16,
    fields: [...display, "profile-walking", "profile-cycling"],
    description:
      "Detailed display, walking and cycling networks, and isochrones. No driving graph or analysis archive.",
  },
  {
    id: "driving",
    label: "Driving · map, routes & address search",
    group: "Your area",
    maxZoom: 16,
    fields: [...display, "profile-driving", "search", "reverse"],
    description:
      "Display, driving routes, location and explicit OSM address search, and nearest-street queries. Address completeness depends on the source.",
  },
  {
    id: "search",
    label: "Search companion · places & addresses",
    group: "Your area",
    maxZoom: 16,
    fields: ["places", "search", "reverse"],
    description:
      "Location search, explicit OSM addresses and nearest streets. Compose this with another visual map; it contains no display tiles or routing graph.",
  },
  {
    id: "analysis",
    label: "AI analysis · objects, areas & search",
    group: "Your area",
    maxZoom: 16,
    fields: [
      "feature-objects",
      "feature-boundaries",
      "search",
      "reverse",
      "query-peaks",
    ],
    description:
      "Tagged source objects, relationships, administrative areas, search and peak queries. Exact extraction data is independent of display zoom. Compose with a display map; the full object archive can dominate file size.",
  },
  {
    id: "water-buildings",
    label: "Water & buildings only",
    group: "Your area",
    maxZoom: 16,
    fields: ["layer-water", "layer-buildings", "ocean"],
    description:
      "Water and building display geometry, including available building heights. No extractable source features.",
  },
  {
    id: "all",
    label: "All available capabilities",
    group: "Your area",
    maxZoom: 16,
    fields: "all",
    description:
      "All available display, routing, search and extraction families. This is the most demanding regional recipe.",
  },
];
export const preparationPreset = (id: string) =>
  PREPARATION_PRESETS.find((p) => p.id === id);
