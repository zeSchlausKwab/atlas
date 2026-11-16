import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Feature } from "geojson";
import { runCompiler } from "../../provisioning/src/process";

export const DISPLAY_GEOMETRY_BYTES = 32 * 1024 ** 2;
const MAX_SOURCE_BYTES = 128 * 1024 ** 2;

/** Bound decompression as well as the geometry passed into the JS tile worker. */
export function inflateDisplaySource(data: Uint8Array, id: string) {
  try {
    return gunzipSync(data, { maxOutputLength: MAX_SOURCE_BYTES });
  } catch (error) {
    throw new Error(
      `Cannot decode display geometry ${id} (128 MiB source limit): ${error}`,
    );
  }
}

/** Only an oversized display copy is generalized; analysis geometry stays intact.
 * Project first: ogr2ogr -simplify uses the input SRS, before its output transform.
 */
export async function generalizeDisplaySource(
  bytes: Uint8Array,
  id: string,
  maxZoom: number,
  scratch: string,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<Feature> {
  signal.throwIfAborted();
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 16)
    throw new Error("Invalid display generalization zoom");
  if (bytes.length > MAX_SOURCE_BYTES)
    throw new Error(`Display geometry ${id} exceeds the 128 MiB source limit`);
  if (!Bun.which("ogr2ogr"))
    throw new Error(
      `Display geometry ${id} needs GDAL (ogr2ogr) for zoom-aware simplification; install GDAL and resume`,
    );
  const tolerance = (2 * Math.PI * 6378137) / (256 * 2 ** maxZoom) / 4;
  progress(
    `Generalizing oversized display geometry ${id} (${(bytes.length / 1024 ** 2).toFixed(1)} MiB) for z${maxZoom}; analysis geometry unchanged`,
  );
  const dir = await mkdtemp(join(resolve(scratch), "display-generalize-"));
  try {
    const input = join(dir, "source.geojson"),
      projected = join(dir, "projected.fgb"),
      output = join(dir, "display.geojson");
    await Bun.write(input, bytes);
    await runCompiler(
      [
        "ogr2ogr",
        "-f",
        "FlatGeobuf",
        projected,
        input,
        "-select",
        "",
        "-s_srs",
        "EPSG:4326",
        "-t_srs",
        "EPSG:3857",
        "-dim",
        "XY",
      ],
      dir,
      signal,
      progress,
    );
    await runCompiler(
      [
        "ogr2ogr",
        "-f",
        "GeoJSON",
        output,
        projected,
        "-simplify",
        String(tolerance),
        "-t_srs",
        "EPSG:4326",
        "-dim",
        "XY",
        "-lco",
        "COORDINATE_PRECISION=7",
      ],
      dir,
      signal,
      progress,
    );
    signal.throwIfAborted();
    if (Bun.file(output).size > DISPLAY_GEOMETRY_BYTES)
      throw new Error(
        `Display geometry ${id} still exceeds 32 MiB after quarter-pixel simplification at z${maxZoom}; it needs spatial partitioning`,
      );
    const reduced = await Bun.file(output).json();
    if (
      reduced.type !== "FeatureCollection" ||
      reduced.features?.length !== 1 ||
      !reduced.features[0]?.geometry
    )
      throw new Error(
        `Display generalization lost geometry ${id}; refusing incomplete tiles`,
      );
    // GDAL's attribute conversion is deliberately ignored: keep exact source tags/ID.
    const original: Feature = JSON.parse(new TextDecoder().decode(bytes));
    const feature = { ...original, geometry: reduced.features[0].geometry };
    if (
      new TextEncoder().encode(JSON.stringify(feature)).length >
      DISPLAY_GEOMETRY_BYTES
    )
      throw new Error(
        `Generalized display feature ${id} exceeds the tile working set`,
      );
    progress(
      `Display geometry ${id} ready: ${(Bun.file(output).size / 1024 ** 2).toFixed(2)} MiB at z${maxZoom}`,
    );
    return feature;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
