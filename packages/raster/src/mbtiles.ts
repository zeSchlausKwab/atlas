import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, open, link, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { StreamWriter } from "../../cli/src/stream-writer";
import type { Manifest } from "../../format/src/index";
import {
  rasterDimensions,
  rasterTile,
  validateRasters,
  type RasterLayer,
} from "../../format/src/raster";

export interface MbtilesOptions {
  /** Original upload name when the on-disk staging path is generated. */
  sourceFilename?: string;
  id?: string;
  name?: string;
  attribution?: string;
  license?: string;
  bounds?: [number, number, number, number];
}
export interface MbtilesPlan {
  inputBytes: number;
  tiles: number;
  tileBytes: number;
  estimatedOutputBytes: number;
  layer: RasterLayer;
  warnings: string[];
}
export interface RasterImportProgress {
  phase: "fingerprint" | "tiles" | "directory" | "payload";
  completed: number;
  total: number;
}
type Row = {
  zoom_level: number;
  tile_column: number;
  tile_row: number;
  tile_data: Uint8Array;
};
function readOnly(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    db.run(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; BEGIN;",
    );
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
function plan(
  db: Database,
  filename: string,
  inputBytes: number,
  options: MbtilesOptions,
): MbtilesPlan {
  const metadata: Record<string, string> = Object.create(null);
  for (const row of db
    .query<
      { name: string; value: string },
      []
    >("SELECT name,value FROM metadata")
    .iterate()) {
    if (
      typeof row.name !== "string" ||
      typeof row.value !== "string" ||
      Object.hasOwn(metadata, row.name)
    )
      throw new Error("Invalid or duplicate MBTiles metadata");
    metadata[row.name] = row.value;
    if (Object.keys(metadata).length > 1024 || row.value.length > 1024 ** 2)
      throw new Error("MBTiles metadata exceeds its limit");
  }
  if (JSON.stringify(metadata).length > 1024 ** 2)
    throw new Error("MBTiles metadata exceeds its limit");
  const encoding = ["jpg", "jpeg", "image/jpeg"].includes(metadata.format)
    ? "jpeg"
    : ["png", "image/png"].includes(metadata.format)
      ? "png"
      : undefined;
  if (!encoding)
    throw new Error(
      `Unsupported MBTiles format '${metadata.format ?? "missing"}'; use JPEG or PNG raster tiles`,
    );
  const scheme = metadata.scheme ?? "tms";
  if (scheme !== "tms" && scheme !== "xyz")
    throw new Error("Unsupported MBTiles row scheme");
  if (metadata.profile && metadata.profile !== "mercator")
    throw new Error("Only Mercator MBTiles are supported");
  // Query the public interface: flat tiles tables and normalized SQLite views both work.
  const totals = db
    .query<
      { n: number; bytes: number; min: number; max: number },
      []
    >("SELECT count(*) AS n, coalesce(sum(length(tile_data)),0) AS bytes, min(zoom_level) AS min, max(zoom_level) AS max FROM tiles")
    .get()!;
  if (!totals.n || !Number.isSafeInteger(totals.bytes))
    throw new Error("Empty or oversized MBTiles archive");
  const invalid = db
    .query(
      `SELECT 1 FROM tiles WHERE typeof(zoom_level)<>'integer' OR zoom_level<0 OR zoom_level>18
    OR typeof(tile_column)<>'integer' OR typeof(tile_row)<>'integer'
    OR tile_column<0 OR tile_row<0 OR tile_column >= (1 << zoom_level) OR tile_row >= (1 << zoom_level)
    OR typeof(tile_data)<>'blob' OR length(tile_data)<4 OR length(tile_data)>8388608 LIMIT 1`,
    )
    .get();
  if (invalid)
    throw new Error(
      "Invalid MBTiles coordinate, zoom (supported 0–18), or tile payload",
    );
  if (
    db
      .query(
        "SELECT 1 FROM tiles GROUP BY zoom_level,tile_column,tile_row HAVING count(*)>1 LIMIT 1",
      )
      .get()
  )
    throw new Error("Duplicate MBTiles tile address");
  const sample = db.query<Row, []>("SELECT * FROM tiles LIMIT 1").get()!;
  const dimensions = rasterDimensions(sample.tile_data, encoding);
  if (dimensions[0] !== dimensions[1] || ![256, 512].includes(dimensions[0]))
    throw new Error("Raster tiles must be 256×256 or 512×512 pixels");
  const sourceFilename = options.sourceFilename ?? basename(filename);
  if (
    !sourceFilename ||
    sourceFilename.length > 255 ||
    /[\\/\x00-\x1f]/.test(sourceFilename)
  )
    throw new Error("Invalid MBTiles source filename");
  const bounds = options.bounds ?? metadata.bounds?.split(",").map(Number);
  if (!bounds)
    throw new Error(
      "MBTiles has no bounds; provide --bounds west,south,east,north",
    );
  const attribution =
    options.attribution ??
    metadata.attribution
      ?.replace(/<[^>]*>/g, "")
      .replace(/&copy;/g, "©")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .trim() ??
    "Attribution not specified in source metadata";
  const layer: RasterLayer = {
    id: options.id ?? "imagery",
    name:
      options.name ??
      metadata.name ??
      sourceFilename.replace(/\.mbtiles$/i, ""),
    version: 1,
    kind: "imagery",
    crs: "EPSG:3857",
    matrix: "xyz",
    encoding,
    tileSize: dimensions[0] as 256 | 512,
    minZoom: totals.min,
    maxZoom: totals.max,
    bounds: bounds as RasterLayer["bounds"],
    source: {
      url: `mbtiles:${sourceFilename}`,
      attribution,
      license:
        options.license ??
        metadata.license ??
        "Not specified in MBTiles metadata; original provider terms apply",
    },
    mbtiles: { filename: sourceFilename, scheme, metadata },
  };
  validateRasters([layer]);
  const warnings: string[] = [];
  if (!options.license && !metadata.license)
    warnings.push(
      "Source metadata does not specify a licence; no redistribution licence is inferred.",
    );
  if (scheme === "xyz")
    warnings.push(
      "Honouring explicit scheme=xyz metadata; standard MBTiles uses TMS rows.",
    );
  if (
    (metadata.minzoom !== undefined &&
      Number(metadata.minzoom) !== totals.min) ||
    (metadata.maxzoom !== undefined && Number(metadata.maxzoom) !== totals.max)
  )
    warnings.push(
      "Zoom limits were derived from actual tiles; metadata disagrees.",
    );
  return {
    inputBytes,
    tiles: totals.n,
    tileBytes: totals.bytes,
    estimatedOutputBytes: totals.bytes + totals.n * 256 + 1024 ** 2,
    layer,
    warnings,
  };
}
async function stableFile(path: string) {
  const s = await stat(path, { bigint: true });
  if (!s.isFile()) throw new Error("MBTiles input must be a regular file");
  if ((await stat(path + "-wal").catch(() => undefined))?.size)
    throw new Error(
      "MBTiles has a live WAL; close its writer and checkpoint it before import",
    );
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
export async function inspectMbtiles(
  path: string,
  options: MbtilesOptions = {},
): Promise<MbtilesPlan> {
  const before = await stableFile(path),
    db = readOnly(path);
  try {
    const result = plan(db, path, (await stat(path)).size, options);
    if (before !== (await stableFile(path)))
      throw new Error("MBTiles source changed during inspection");
    return result;
  } finally {
    db.close();
  }
}
/** Copies encoded tile bytes directly into paged Atlas blocks. No image transcoding or extraction directory. */
export async function importMbtiles(
  path: string,
  output: string,
  options: MbtilesOptions = {},
  maxBytes = Number.MAX_SAFE_INTEGER,
  signal = new AbortController().signal,
  progress: (p: RasterImportProgress) => void = () => {},
) {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid output budget");
  if (resolve(path) === resolve(output) || (await Bun.file(output).exists()))
    throw new Error("Output already exists; choose a new .atlas file");
  const before = await stableFile(path),
    db = readOnly(path);
  let writer: StreamWriter | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const staging = output + ".raster.part";
  try {
    const info = plan(db, path, (await stat(path)).size, options);
    if (info.tileBytes > maxBytes)
      throw new Error("Tile payload exceeds output budget");
    lock = await open(output + ".lock", "wx");
    const hash = createHash("sha256");
    let read = 0;
    progress({ phase: "fingerprint", completed: 0, total: info.inputBytes });
    for await (const chunk of createReadStream(path, {
      highWaterMark: 1024 ** 2,
      signal,
    })) {
      hash.update(chunk);
      read += chunk.length;
      progress({
        phase: "fingerprint",
        completed: read,
        total: info.inputBytes,
      });
    }
    const layer = {
      ...info.layer,
      source: { ...info.layer.source, sha256: hash.digest("hex") },
    };
    writer = await new StreamWriter(staging, maxBytes).open();
    let tiles = 0;
    progress({ phase: "tiles", completed: 0, total: info.tiles });
    for (const row of db
      .query<
        Row,
        []
      >("SELECT zoom_level,tile_column,tile_row,tile_data FROM tiles ORDER BY zoom_level,tile_column,tile_row")
      .iterate()) {
      signal.throwIfAborted();
      const {
        zoom_level: z,
        tile_column: x,
        tile_row: inputY,
        tile_data: bytes,
      } = row;
      const y = layer.mbtiles!.scheme === "tms" ? 2 ** z - 1 - inputY : inputY;
      try {
        rasterTile(bytes, layer);
      } catch (e) {
        throw new Error(
          `Invalid tile ${z}/${x}/${inputY}: ${e instanceof Error ? e.message : e}`,
        );
      }
      await writer.add(
        { key: `raster/${layer.id}/${z}/${x}/${y}`, bytes, features: 0 },
        { compress: false },
      );
      progress({ phase: "tiles", completed: ++tiles, total: info.tiles });
    }
    const manifest: Omit<Manifest, "snapshot"> = {
      format: "atlas",
      version: 1,
      name: layer.name,
      bounds: layer.bounds,
      minZoom: layer.minZoom,
      maxZoom: layer.maxZoom,
      features: 0,
      peaks: 0,
      places: [],
      tileLayers: [],
      rasters: [layer],
      capabilities: ["raster-rendering"],
      source: layer.source,
      limitations: [
        "Visual satellite/raster imagery only; pixel values are not elevation measurements.",
        "Original encoded tiles and metadata retained. Capture date, precision and licence are only known if supplied by the source.",
        "Bounds follow source metadata; missing tiles are not synthesized. Beyond maximum zoom, pixels are enlarged.",
      ],
    };
    const size = await writer.finish(
      manifest,
      undefined,
      (phase, completed, total) => {
        signal.throwIfAborted();
        progress({ phase, completed, total });
      },
    );
    signal.throwIfAborted();
    if (before !== (await stableFile(path)))
      throw new Error("MBTiles source changed during import; output discarded");
    await link(staging, output);
    return { ...info, layer, size, output: resolve(output) };
  } catch (e) {
    await writer?.abort();
    throw e;
  } finally {
    db.close();
    if (lock) {
      await rm(staging, { force: true });
      await lock.close();
      await rm(output + ".lock", { force: true });
    }
  }
}
