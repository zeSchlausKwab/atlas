import { rename, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { fileHash } from "../../cli/src/source";
import { validateOcean } from "../../cli/src/ocean-tiles";
import { bounds } from "../../offline/src/geometry";
import type { PackageSelection } from "./selection";
import { runCompiler } from "./process";
export interface OceanSource {
  url: string;
  sha256: string;
  bytes: number;
}
export interface PreparedOcean {
  data: FeatureCollection<Polygon | MultiPolygon>;
  source: OceanSource;
  clipHash: string;
  clipBytes: number;
}
/** Paths are server configuration, never request input. Provider metadata is pinned into the recipe. */
export async function configuredOcean(path = process.env.ATLAS_OCEAN_SOURCE) {
  if (!path) return undefined;
  const source = (await Bun.file(path + ".source.json").json()) as OceanSource;
  if (
    !/^https?:\/\//.test(source.url) ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes <= 0 ||
    Bun.file(path).size !== source.bytes
  )
    throw new Error("Configured ocean source metadata or size is invalid");
  return { ...source, path: resolve(path) };
}
export async function prepareOcean(
  s: PackageSelection,
  work: string,
  signal: AbortSignal,
  progress: (s: string) => void,
  path = process.env.ATLAS_OCEAN_SOURCE,
): Promise<PreparedOcean | undefined> {
  if (!s.ocean) return;
  const source = await configuredOcean(path);
  if (!source || source.sha256 !== s.ocean.sha256)
    throw new Error("Pinned ocean source is unavailable or changed");
  progress("Verifying assembled ocean source before map compilation");
  if ((await fileHash(source.path, undefined, signal)) !== source.sha256)
    throw new Error("Ocean source checksum mismatch");
  await mkdir(work, { recursive: true });
  const clip = join(work, "ocean.geojson"),
    receipt = clip + ".receipt.json";
  const identity = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({ version: 2, source: source.sha256, polygon: s.polygon }),
    )
    .digest("hex");
  let saved: { identity: string; sha256: string } | undefined;
  if (await Bun.file(receipt).exists()) saved = await Bun.file(receipt).json();
  if (saved && saved.identity !== identity)
    throw new Error("Ocean checkpoint belongs to another recipe");
  if (saved) {
    if ((await fileHash(clip, undefined, signal)) !== saved.sha256)
      throw new Error("Ocean checkpoint changed on disk");
  } else {
    if (!Bun.which("ogr2ogr"))
      throw new Error("Ocean preparation needs GDAL (ogr2ogr) on the server");
    const partial = clip + ".part.geojson",
      polygon = join(work, "ocean-clip.geojson");
    await Bun.write(
      polygon,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[...s.polygon, s.polygon[0]]],
            },
          },
        ],
      }),
    );
    progress("Clipping assembled sea polygons to the selected area");
    try {
      await rm(partial, { force: true });
      await runCompiler(
        [
          "ogr2ogr",
          "-f",
          "GeoJSON",
          partial,
          `/vsizip/${source.path}/water-polygons-split-4326/water_polygons.shp`,
          "-spat",
          ...bounds(s.polygon).map(String),
          "-clipsrc",
          polygon,
          "-makevalid",
          "-t_srs",
          "EPSG:4326",
          "-dim",
          "XY",
          "-lco",
          "COORDINATE_PRECISION=7",
        ],
        work,
        signal,
        progress,
      );
      await rename(partial, clip);
    } finally {
      await rm(partial, { force: true });
    }
  }
  // Check before the multi-hour PBF pass. The bounded input is shared by tiling and source-object indexing.
  const file = Bun.file(clip);
  if (file.size > 512 * 1024 ** 2)
    throw new Error(
      "Clipped ocean exceeds 512 MiB; use a smaller area or partition the coastline input",
    );
  const raw = await file.json();
  const data = normalizeOcean(raw);
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw new Error("Invalid clipped ocean data");
  if (data.features.length) validateOcean(data, bounds(s.polygon));
  const clipHash = await fileHash(clip, undefined, signal);
  if (!saved) {
    await Bun.write(
      receipt + ".part",
      JSON.stringify({ identity, sha256: clipHash }),
    );
    await rename(receipt + ".part", receipt);
  }
  progress(
    `Ocean input ready: ${data.features.length} polygons, ${(file.size / 1024 ** 2).toFixed(1)} MiB`,
  );
  const { path: _, ...metadata } = source;
  return { data, source: metadata, clipHash, clipBytes: file.size };
}

/** Clipping can create collections with zero-area line remnants along the cut. Retain every polygon and hole. */
export function normalizeOcean(
  raw: any,
): FeatureCollection<Polygon | MultiPolygon> {
  if (raw?.type !== "FeatureCollection" || !Array.isArray(raw.features))
    throw new Error("Invalid clipped ocean data");
  const features: FeatureCollection<Polygon | MultiPolygon>["features"] = [];
  const visit = (g: any) => {
    if (!g) return;
    if (g.type === "GeometryCollection") {
      for (const part of g.geometries) visit(part);
      return;
    }
    if (g.type === "Polygon" || g.type === "MultiPolygon")
      features.push({ type: "Feature", properties: {}, geometry: g });
    else if (
      !["LineString", "MultiLineString", "Point", "MultiPoint"].includes(g.type)
    )
      throw new Error("Unsupported ocean geometry");
  };
  for (const feature of raw.features) visit(feature.geometry);
  return { type: "FeatureCollection", features };
}
