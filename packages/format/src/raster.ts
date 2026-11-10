/** Visual rasters have their own provenance; they do not imply numeric elevation. */
export interface RasterLayer {
  id: string;
  name: string;
  version: 1;
  kind: "imagery" | "shaded-relief";
  crs: "EPSG:3857";
  matrix: "xyz";
  encoding: "png" | "jpeg";
  tileSize: 256 | 512;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  source: {
    url: string;
    attribution: string;
    license: string;
    sha256?: string;
  };
  /** Source metadata is retained as data, never interpreted as executable HTML. */
  mbtiles?: {
    filename: string;
    scheme: "tms" | "xyz";
    metadata: Record<string, string>;
  };
  provenance?: { archiveSnapshot: string; layerId: string };
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
      !["png", "jpeg"].includes(r.encoding) ||
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
    if (
      r.provenance &&
      (!/^[a-f0-9]{64}$/.test(r.provenance.archiveSnapshot) ||
        typeof r.provenance.layerId !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(r.provenance.layerId))
    )
      throw new Error("Invalid raster provenance");
    if (
      r.source.sha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(r.source.sha256)
    )
      throw new Error("Invalid raster source fingerprint");
    if (
      r.mbtiles &&
      (typeof r.mbtiles.filename !== "string" ||
        !r.mbtiles.filename ||
        !["tms", "xyz"].includes(r.mbtiles.scheme) ||
        !r.mbtiles.metadata ||
        typeof r.mbtiles.metadata !== "object" ||
        Array.isArray(r.mbtiles.metadata) ||
        !Object.values(r.mbtiles.metadata).every(
          (v) => typeof v === "string",
        ) ||
        JSON.stringify(r.mbtiles).length > 1024 ** 2)
    )
      throw new Error("Invalid MBTiles provenance");
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
  const [width, height] = rasterDimensions(bytes, "png");
  if (width !== size || height !== size)
    throw new Error("PNG tile dimensions disagree with raster catalog");
}

/** Inspect dimensions before image decoding. Compressed bytes remain unchanged. */
export function rasterDimensions(
  bytes: Uint8Array,
  encoding: RasterLayer["encoding"],
): [number, number] {
  if (bytes.length > 8 * 1024 ** 2)
    throw new Error("Raster tile exceeds 8 MiB");
  if (encoding === "png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      bytes.length < 33 ||
      signature.some((v, i) => bytes[i] !== v) ||
      String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
    )
      throw new Error("Invalid PNG tile");
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [d.getUint32(16), d.getUint32(20)];
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  )
    throw new Error("Invalid or truncated JPEG tile");
  let dimensions: [number, number] | undefined;
  for (let at = 2; at < bytes.length; ) {
    if (bytes[at++] !== 0xff) break;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xd9 || marker === 0x00) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) break;
    const length = bytes[at]! * 256 + bytes[at + 1]!;
    if (length < 2 || at + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || bytes[at + 2] !== 8) break;
      dimensions = [
        bytes[at + 5]! * 256 + bytes[at + 6]!,
        bytes[at + 3]! * 256 + bytes[at + 4]!,
      ];
      if (length !== 8 + 3 * bytes[at + 7]!) break;
    }
    // A frame header alone isn't an image. Require a scan and end-of-image marker.
    if (marker === 0xda) {
      if (
        dimensions &&
        dimensions.every((n) => n > 0) &&
        length >= 6 &&
        at + length < bytes.length - 2
      )
        return dimensions;
      break;
    }
    at += length;
  }
  throw new Error("Invalid or unsupported JPEG tile");
}
export function rasterTile(
  bytes: Uint8Array,
  layer: Pick<RasterLayer, "encoding" | "tileSize">,
) {
  const dimensions = rasterDimensions(bytes, layer.encoding);
  if (dimensions.some((n) => n !== layer.tileSize))
    throw new Error("Raster tile dimensions disagree with raster catalog");
}
export function rasterMime(encoding: RasterLayer["encoding"]) {
  return encoding === "jpeg" ? "image/jpeg" : "image/png";
}
