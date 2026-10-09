import { MAP_LAYERS, type Manifest } from "./index";
export interface MapOffer {
  id: string;
  url: string;
  api: string;
  bytes: number;
  manifest: Manifest;
}
export function httpUrl(value: string, base?: string) {
  const url = new URL(value, base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) URL without credentials.");
  return url.href;
}
/** Offers are discovery hints. The reader validates the actual package, and its
 * snapshot must agree before a catalog offer can participate in a composition. */
export function parseCatalog(value: unknown, base: string): MapOffer[] {
  const maps = (value as { maps?: unknown })?.maps;
  if (!Array.isArray(maps) || maps.length > 1000)
    throw new Error("Invalid Atlas catalog");
  const seen = new Set<string>();
  return maps.map((m) => {
    const f = m?.manifest;
    if (
      !m ||
      typeof m.id !== "string" ||
      typeof m.url !== "string" ||
      typeof m.api !== "string" ||
      !Number.isSafeInteger(m.bytes) ||
      m.bytes <= 0 ||
      !f ||
      typeof f.name !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.snapshot) ||
      !Array.isArray(f.bounds) ||
      f.bounds.length !== 4 ||
      !f.bounds.every(Number.isFinite) ||
      f.bounds[0] >= f.bounds[2] ||
      f.bounds[1] >= f.bounds[3] ||
      f.bounds[0] < -180 ||
      f.bounds[2] > 180 ||
      f.bounds[1] < -90 ||
      f.bounds[3] > 90 ||
      !Number.isInteger(f.minZoom) ||
      !Number.isInteger(f.maxZoom) ||
      f.minZoom < 0 ||
      f.maxZoom > 18 ||
      f.minZoom > f.maxZoom ||
      !Array.isArray(f.capabilities) ||
      !f.capabilities.every((s: unknown) => typeof s === "string") ||
      (f.tileLayers !== undefined &&
        (!Array.isArray(f.tileLayers) ||
          !f.tileLayers.every((s: unknown) => MAP_LAYERS.includes(s as never))))
    )
      throw new Error("Invalid map offer in catalog");
    const url = httpUrl(m.url, base);
    if (seen.has(url)) throw new Error("Duplicate map URL in catalog");
    seen.add(url);
    return {
      id: m.id,
      url,
      api: httpUrl(m.api, base),
      bytes: m.bytes,
      manifest: f,
    };
  });
}
