/** Visual rasters have their own provenance; they do not imply numeric elevation. */
export interface RasterLayer {
  id: string;
  name: string;
  version: 1;
  kind: "imagery" | "shaded-relief";
  crs: "EPSG:3857";
  matrix: "xyz";
  encoding: "png";
  tileSize: 256 | 512;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  source: { url: string; attribution: string; license: string };
  registration?: {
    method: "north-up-mercator-bounds";
    width: number;
    height: number;
    sha256: string;
    accuracy: string;
    resampling: "area-overviews-and-bilinear";
  };
}
export function validateRasters(
  value: unknown,
): asserts value is RasterLayer[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Invalid raster catalog");
  const ids = new Set();
  for (const r of value) {
    if (
      !r ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(r.id) ||
      ids.has(r.id) ||
      r.version !== 1 ||
      !["imagery", "shaded-relief"].includes(r.kind) ||
      r.crs !== "EPSG:3857" ||
      r.matrix !== "xyz" ||
      r.encoding !== "png" ||
      ![256, 512].includes(r.tileSize) ||
      typeof r.name !== "string" ||
      !r.name.length ||
      !Number.isInteger(r.minZoom) ||
      !Number.isInteger(r.maxZoom) ||
      r.minZoom < 0 ||
      r.maxZoom > 18 ||
      r.minZoom > r.maxZoom ||
      !Array.isArray(r.bounds) ||
      r.bounds.length !== 4 ||
      !r.bounds.every(Number.isFinite) ||
      r.bounds[0] < -180 ||
      r.bounds[2] > 180 ||
      r.bounds[1] < -85.05112878 ||
      r.bounds[3] > 85.05112878 ||
      r.bounds[0] >= r.bounds[2] ||
      r.bounds[1] >= r.bounds[3] ||
      !r.source ||
      ![r.source.url, r.source.attribution, r.source.license].every(
        (v) => typeof v === "string" && v.length > 0,
      )
    )
      throw new Error("Invalid raster layer descriptor");
    if (r.registration) {
      const g = r.registration;
      if (
        g.method !== "north-up-mercator-bounds" ||
        !Number.isInteger(g.width) ||
        g.width < 1 ||
        !Number.isInteger(g.height) ||
        g.height < 1 ||
        !/^[a-f0-9]{64}$/.test(g.sha256) ||
        typeof g.accuracy !== "string" ||
        !g.accuracy ||
        g.resampling !== "area-overviews-and-bilinear"
      )
        throw new Error("Invalid image registration");
    }
    ids.add(r.id);
  }
}
export function pngTile(bytes: Uint8Array, size: number) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 33 ||
    bytes.length > 8 * 1024 ** 2 ||
    signature.some((v, i) => bytes[i] !== v) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    throw new Error("Invalid PNG tile");
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.getUint32(16) !== size || d.getUint32(20) !== size)
    throw new Error("PNG tile dimensions disagree with raster catalog");
}
