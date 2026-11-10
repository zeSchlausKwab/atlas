import { MAP_LAYERS, type MapLayer } from "../../format/src/index";
import { mapReference } from "../../format/src/urls";
import {
  PAPER,
  FLAT_SCENE,
  parseStyle,
  parseScene,
  type MapStyle,
  type MapScene,
} from "../../renderer/src/style";
import type { RasterLayerViews } from "../../renderer/src/raster";

export const TOOL_PURPOSES = [
  "routing",
  "search",
  "queries",
  "features",
] as const;
export type ToolPurpose = (typeof TOOL_PURPOSES)[number];
export interface Presentation {
  style: MapStyle;
  scene: MapScene;
  layers: MapLayer[];
  labels: { places: boolean; streets: boolean; pois: boolean };
  /** Permission to read on demand, never a request to preload. */
  tools: ToolPurpose[];
}
export interface ViewSource {
  url: string;
  root: string;
  enabled: boolean;
  layers: MapLayer[];
  labels: boolean;
  rasterLayers?: RasterLayerViews;
}
export interface ViewCamera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}
export interface ViewRecipe {
  version: 1;
  id: string;
  name: string;
  sources: ViewSource[];
  presentation: Presentation;
  camera?: ViewCamera;
  coverage: boolean;
}
export function defaultPresentation(): Presentation {
  return {
    style: parseStyle(PAPER),
    scene: { ...FLAT_SCENE },
    layers: [...MAP_LAYERS],
    labels: { places: true, streets: true, pois: true },
    tools: [...TOOL_PURPOSES],
  };
}
function record(v: unknown, label: string): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`Invalid ${label}`);
  return v as Record<string, any>;
}
function bool(v: unknown): boolean {
  if (typeof v !== "boolean") throw new Error("Expected a boolean");
  return v;
}
function choices<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (
    !Array.isArray(v) ||
    v.length > allowed.length ||
    new Set(v).size !== v.length ||
    v.some((x) => !allowed.includes(x))
  )
    throw new Error("Invalid view data selection");
  // Canonical order keeps equality and signed revisions stable.
  return allowed.filter((x) => v.includes(x));
}
export function parsePresentation(v: unknown): Presentation {
  const p = record(v, "presentation"),
    l = record(p.labels, "label selection");
  return {
    style: parseStyle(p.style),
    scene: parseScene(p.scene),
    layers: choices(p.layers, MAP_LAYERS),
    labels: {
      places: bool(l.places),
      streets: bool(l.streets),
      pois: bool(l.pois),
    },
    tools: choices(p.tools, TOOL_PURPOSES),
  };
}
export function parseCamera(v: unknown): ViewCamera {
  const c = record(v, "camera");
  if (
    !Array.isArray(c.center) ||
    c.center.length !== 2 ||
    c.center.some(
      (n: unknown) =>
        typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1,
    ) ||
    ![c.zoom, c.pitch, c.bearing].every(Number.isFinite) ||
    c.zoom < 0 ||
    c.zoom > 20 ||
    c.pitch < 0 ||
    c.pitch > 60 ||
    Math.abs(c.bearing) > 360
  )
    throw new Error("Invalid view camera");
  return {
    center: [...c.center] as [number, number],
    zoom: c.zoom,
    pitch: c.pitch,
    bearing: c.bearing,
  };
}
export function parseViewRecipe(value: unknown): ViewRecipe {
  if (JSON.stringify(value).length > 128 * 1024)
    throw new Error("View recipe is too large");
  const v = record(value, "view recipe");
  if (
    v.version !== 1 ||
    typeof v.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.id) ||
    typeof v.name !== "string" ||
    !v.name.trim() ||
    v.name.length > 120 ||
    !Array.isArray(v.sources) ||
    !v.sources.length ||
    v.sources.length > 8
  )
    throw new Error("Invalid view recipe");
  const sources = v.sources.map((x: unknown): ViewSource => {
    const s = record(x, "view source");
    if (typeof s.root !== "string" || !/^[a-f0-9]{64}$/.test(s.root))
      throw new Error("View sources require pinned Hashtree roots");
    const rasters: RasterLayerViews = {};
    if (s.rasterLayers !== undefined) {
      const r = record(s.rasterLayers, "imagery selection");
      if (Object.keys(r).length > 64)
        throw new Error("Too many imagery layers");
      for (const [id, state] of Object.entries(r)) {
        if (
          !/^[a-zA-Z0-9:_-]{1,120}$/.test(id) ||
          ["__proto__", "constructor", "prototype"].includes(id)
        )
          throw new Error("Invalid imagery id");
        const t = record(state, "imagery state");
        if (!Number.isFinite(t.opacity) || t.opacity < 0 || t.opacity > 1)
          throw new Error("Invalid imagery opacity");
        rasters[id] = { enabled: bool(t.enabled), opacity: t.opacity };
      }
    }
    return {
      url: mapReference(s.url, s.url, s.root),
      root: s.root,
      enabled: bool(s.enabled),
      layers: choices(s.layers, MAP_LAYERS),
      labels: bool(s.labels),
      rasterLayers: rasters,
    };
  });
  if (
    new Set(sources.map((s: ViewSource) => s.root)).size !== sources.length ||
    !sources.some((s: ViewSource) => s.enabled)
  )
    throw new Error("Choose distinct sources and enable at least one");
  return {
    version: 1,
    id: v.id,
    name: v.name.trim(),
    sources,
    presentation: parsePresentation(v.presentation),
    ...(v.camera ? { camera: parseCamera(v.camera) } : {}),
    coverage: bool(v.coverage),
  };
}
