import { project, sha256 } from "../../format/src/index";
import { validateRasters, type RasterLayer } from "../../format/src/raster";

export const IMAGE_MAX_BYTES = 64 * 1024 ** 2;
export const IMAGE_MAX_PIXELS = 32 * 1024 ** 2;
export interface ImagePlacement {
  name: string;
  bounds: [number, number, number, number];
  attribution: string;
  license: string;
}
export interface ImageImport {
  layer: RasterLayer;
  width: number;
  height: number;
  inputBytes: number;
  sha256: string;
  tiles: number;
  estimatedBytes: number;
}
export function imageDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 33 ||
    bytes.length > IMAGE_MAX_BYTES ||
    [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    throw new Error(
      "Upload a PNG image of at most 64 MiB. The host UI converts JPEG images to PNG.",
    );
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = v.getUint32(16),
    height = v.getUint32(20);
  if (!width || !height || width * height > IMAGE_MAX_PIXELS)
    throw new Error(
      "This image importer supports up to 32 megapixels. Crop or resize the image first.",
    );
  return { width, height };
}
export function projectedImage(bounds: ImagePlacement["bounds"]) {
  const [west, north] = project(bounds[0], bounds[3]),
    [east, south] = project(bounds[2], bounds[1]);
  return [west, north, east, south] as const;
}
export function imageTiles(
  layer: Pick<RasterLayer, "bounds" | "minZoom" | "maxZoom">,
) {
  const [w, n, e, s] = projectedImage(layer.bounds);
  const tiles: { z: number; x: number; y: number }[] = [];
  for (let z = layer.minZoom; z <= layer.maxZoom; z++) {
    const scale = 2 ** z;
    for (
      let x = Math.max(0, Math.floor(w * scale));
      x < Math.min(scale, Math.ceil(e * scale));
      x++
    )
      for (
        let y = Math.max(0, Math.floor(n * scale));
        y < Math.min(scale, Math.ceil(s * scale));
        y++
      )
        tiles.push({ z, x, y });
  }
  return tiles;
}
export function imageLayout(
  width: number,
  height: number,
  bounds: ImagePlacement["bounds"],
) {
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -85.05112878 ||
    bounds[3] > 85.05112878 ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3]
  )
    throw new Error(
      "Enter west < east and south < north, within the Web Mercator world.",
    );
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > IMAGE_MAX_PIXELS
  )
    throw new Error("Image dimensions must be within 32 megapixels.");
  const [w, n, e, s] = projectedImage(bounds);
  if (e - w < 1e-12 || s - n < 1e-12)
    throw new Error("The image extent is too small");
  const maxZoom = Math.max(
    0,
    Math.min(
      18,
      Math.floor(
        Math.log2(Math.min(width / ((e - w) * 256), height / ((s - n) * 256))) +
          1e-9,
      ),
    ),
  );
  return { maxZoom, tiles: imageTiles({ bounds, minZoom: 0, maxZoom }).length };
}
export async function planImage(
  bytes: Uint8Array,
  value: unknown,
): Promise<ImageImport> {
  const p = value as ImagePlacement;
  if (
    !p ||
    [p.name, p.attribution, p.license].some(
      (v) => typeof v !== "string" || !v.trim() || v.length > 1000,
    ) ||
    p.name.length > 80
  )
    throw new Error(
      "Provide an image name (up to 80 characters), attribution and licence.",
    );
  const { width, height } = imageDimensions(bytes),
    hash = await sha256(bytes);
  const layer: RasterLayer = {
    id: "image",
    name: p.name.trim(),
    version: 1,
    kind: "imagery",
    crs: "EPSG:3857",
    matrix: "xyz",
    encoding: "png",
    tileSize: 256,
    minZoom: 0,
    maxZoom: 0,
    bounds: p.bounds,
    source: {
      url: `urn:sha256:${hash}`,
      attribution: p.attribution.trim(),
      license: p.license.trim(),
    },
    registration: {
      method: "north-up-mercator-bounds",
      width,
      height,
      sha256: hash,
      accuracy: "user-positioned; not independently surveyed",
      resampling: "area-overviews-and-bilinear",
    },
  };
  validateRasters([layer]);
  const { maxZoom, tiles } = imageLayout(width, height, p.bounds);
  layer.maxZoom = maxZoom;
  // Source, temporary pyramid and finished archive; raw RGBA is a conservative disk allowance.
  return {
    layer,
    width,
    height,
    inputBytes: bytes.length,
    sha256: hash,
    tiles,
    estimatedBytes: bytes.length + tiles * (256 * 256 * 4 + 2048) * 2,
  };
}
