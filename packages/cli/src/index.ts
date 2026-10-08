#!/usr/bin/env bun
import { MAP_LAYERS } from "../../format/src/index";
import { splitTile } from "../../format/src/tiles";
import { splitPackageLayers } from "./split-layers";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash } from "./source";
import { buildGeocoding } from "../../geocoding/src/compile";
import type { Location } from "../../geocoding/src/model";
import geojsonvt from "geojson-vt";
import type { FeatureCollection } from "geojson";
import { buildLabels, partitionLabels } from "../../labels/src/compile";
import { LABEL_ZOOM } from "../../labels/src/index";
import { displayMinZoom } from "./display";
import { buildFeatures } from "../../features/src/compile";
import { FEATURE_ZOOM } from "../../features/src/index";
import { DiskWriter } from "./disk-writer";
import {
  HEADER_SIZE,
  TILE_EXTENT,
  parseHeader,
  parseIndex,
  project,
  sha256,
  type Peak,
  type Place,
  type RoutingMetadata,
} from "../../format/src/index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_URL =
  "https://download.geofabrik.de/europe/liechtenstein-261006.osm.pbf";
const DEFAULT_INPUT = resolve(ROOT, "data/liechtenstein.osm.pbf");
const DEFAULT_OUTPUT = resolve(ROOT, "data/liechtenstein.atlas");
function args(argv: string[]) {
  const command = argv.shift() ?? "help";
  const flags: Record<string, string | boolean> = {};
  const boolean = new Set([
    "help",
    "dry-run",
    "no-source-features",
    "features",
  ]);
  const allowed = new Set([
    "url",
    "out",
    "input",
    "output",
    "name",
    "min-zoom",
    "max-zoom",
    "max-bytes",
    "format",
    "sha256",
    ...boolean,
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const split = arg.indexOf("=");
    const key = arg.slice(2, split < 0 ? undefined : split);
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    if (boolean.has(key)) {
      if (split >= 0) throw new Error(`--${key} does not take a value`);
      flags[key] = true;
      continue;
    }
    const value = split < 0 ? argv[++i] : arg.slice(split + 1);
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for --${key}`);
    flags[key] = value;
  }
  return { command, flags };
}
function text(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: string,
) {
  return typeof flags[key] === "string" ? (flags[key] as string) : fallback;
}
function report(value: Record<string, unknown>, format: string) {
  if (format === "json") console.log(JSON.stringify(value, null, 2));
  else
    console.log(
      Object.entries(value)
        .map(
          ([k, v]) =>
            `- **${k}:** ${typeof v === "object" ? JSON.stringify(v) : v}`,
        )
        .join("\n"),
    );
}
function encodeTile(features: geojsonvt.Feature[]): Uint8Array {
  const normalized = features.map((f) => ({
    class: Number(f.tags?.class ?? 3),
    type: f.type,
    parts: (f.type === 1 ? [f.geometry] : f.geometry) as number[][][],
  }));
  const length =
    8 +
    normalized.reduce(
      (n, f) => n + 4 + f.parts.reduce((n, p) => n + 4 + p.length * 4, 0),
      0,
    );
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("TIL1"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, features.length, true);
  let pos = 8;
  for (const f of normalized) {
    if (f.parts.length > 65535) throw new Error("Tile part limit exceeded");
    view.setUint8(pos++, f.class);
    view.setUint8(pos++, f.type);
    view.setUint16(pos, f.parts.length, true);
    pos += 2;
    for (const part of f.parts) {
      view.setUint32(pos, part.length, true);
      pos += 4;
      for (const point of part) {
        view.setUint16(
          pos,
          Math.max(0, Math.min(TILE_EXTENT, Math.round(point[0]!))),
          true,
        );
        view.setUint16(
          pos + 2,
          Math.max(0, Math.min(TILE_EXTENT, Math.round(point[1]!))),
          true,
        );
        pos += 4;
      }
    }
  }
  return bytes;
}
async function main() {
  const { command, flags } = args(process.argv.slice(2));
  const format = text(flags, "format", "md");
  if (!["md", "json"].includes(format))
    throw new Error("--format must be md or json");
  if (command === "help" || flags.help) {
    console.log(
      `ATLAS prototype compiler\n\nUsage:\n  bun run cli fetch [--url URL] [--out FILE] [--sha256 HASH] [--dry-run]\n  bun run cli generate [--input FILE.osm.pbf] [--output FILE.atlas]\n                       [--name NAME] [--min-zoom 9] [--max-zoom 14] [--dry-run]\n                       [--max-bytes 2000000000] [--no-source-features] [--features]\n  bun run cli split-layers --input FILE.atlas [--output FILE.atlas]\n  bun run cli inspect [--input FILE.atlas]\n\nAll commands support --format md|json and --flag=value. Defaults use Liechtenstein.\n--features adds optional spatial source geometry for selection and GeoJSON export.\nThe generator requires Cargo. Rust/WASM compilation is a separate bun run build:wasm step.`,
    );
    return;
  }
  if (command === "split-layers") {
    const input = resolve(text(flags, "input", DEFAULT_OUTPUT)),
      output = resolve(text(flags, "output", input));
    const maxBytes = Number(text(flags, "max-bytes", "2000000000"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid --max-bytes");
    if (flags["dry-run"]) {
      report({ action: "split-map-layers", input, output, maxBytes }, format);
      return;
    }
    report(
      await splitPackageLayers(input, output, maxBytes, console.log),
      format,
    );
    return;
  }
  if (command === "fetch") {
    const url = text(flags, "url", DEFAULT_URL);
    const out = resolve(text(flags, "out", DEFAULT_INPUT));
    if (flags["dry-run"]) {
      report({ action: "download", url, out }, format);
      return;
    }
    await mkdir(dirname(out), { recursive: true });
    const existing = Bun.file(out);
    if (await existing.exists()) {
      const hash = await sha256(new Uint8Array(await existing.arrayBuffer()));
      const metadataFile = Bun.file(`${out}.source.json`);
      const metadata = (await metadataFile.exists())
        ? await metadataFile.json()
        : null;
      if (!metadata || metadata.url !== url || metadata.sha256 !== hash)
        throw new Error(
          "Existing input does not match this source recipe; choose a new --out path",
        );
      if (flags.sha256 && flags.sha256 !== hash)
        throw new Error("Existing input checksum mismatch");
      report(
        { cached: true, file: out, bytes: existing.size, sha256: hash },
        format,
      );
      return;
    }
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = await sha256(bytes);
    if (flags.sha256 && hash !== flags.sha256)
      throw new Error("Downloaded source checksum mismatch");
    await Bun.write(`${out}.part`, bytes);
    await rename(`${out}.part`, out);
    await Bun.write(
      `${out}.source.json`,
      JSON.stringify(
        { url, sha256: hash, fetchedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    report({ file: out, bytes: bytes.length, sha256: hash, url }, format);
    return;
  }
  if (command === "generate") {
    const input = resolve(text(flags, "input", DEFAULT_INPUT));
    const output = resolve(text(flags, "output", DEFAULT_OUTPUT));
    const minZoom = Number(text(flags, "min-zoom", "9"));
    const maxZoom = Number(text(flags, "max-zoom", "14"));
    if (
      ![minZoom, maxZoom].every(Number.isInteger) ||
      minZoom < 0 ||
      maxZoom > 16 ||
      minZoom > maxZoom
    )
      throw new Error("Zooms must be integers with 0 ≤ min ≤ max ≤ 16");
    if (flags["dry-run"]) {
      report({ action: "generate", input, output, minZoom, maxZoom }, format);
      return;
    }
    if (!(await Bun.file(input).exists()))
      throw new Error(`Missing source ${input}; run bun run data:fetch`);
    await mkdir(dirname(output), { recursive: true });
    const importedPath = `${output}.import.json`;
    const proc = Bun.spawn(
      [
        "cargo",
        "run",
        "--quiet",
        "--release",
        "-p",
        "atlas-osm-import",
        "--",
        input,
        importedPath,
      ],
      { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) throw new Error("OSM importer failed");
    const imported = (await Bun.file(importedPath).json()) as {
      geojson: FeatureCollection;
      peaks: Peak[];
      places: Place[];
      skippedWays: number;
      assembledRelations: number;
      skippedRelations: number;
      routing: RoutingMetadata;
      locations: Location[];
    };
    const bounds: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ];
    function visit(coords: unknown): void {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number") {
        bounds[0] = Math.min(bounds[0], coords[0]);
        bounds[1] = Math.min(bounds[1], coords[1]);
        bounds[2] = Math.max(bounds[2], coords[0]);
        bounds[3] = Math.max(bounds[3], coords[1]);
      } else for (const child of coords) visit(child);
    }
    for (const f of imported.geojson.features)
      if (f.geometry && "coordinates" in f.geometry)
        visit(f.geometry.coordinates);
    if (!bounds.every(Number.isFinite))
      throw new Error("No supported features in input");
    console.log(`Indexing ${imported.geojson.features.length} features…`);
    // Preserve the small regional footprint in world overviews. At normal map
    // scales, a half-pixel tolerance avoids shipping invisible vertex detail.
    const makeIndex = (overview: boolean) =>
      geojsonvt(
        overview
          ? {
              ...imported.geojson,
              features: imported.geojson.features.filter(
                (f) => displayMinZoom(f.properties ?? {}) <= 5,
              ),
            }
          : imported.geojson,
        {
          maxZoom,
          extent: TILE_EXTENT,
          buffer: 0,
          tolerance: overview ? 5 : TILE_EXTENT / 512,
          indexMaxZoom: overview ? 0 : Math.min(maxZoom, 5),
          indexMaxPoints: 100000,
        },
      );
    let index = makeIndex(minZoom <= 5);
    const nw = project(bounds[0], bounds[3]);
    const se = project(bounds[2], bounds[1]);
    const maxBytes = Number(text(flags, "max-bytes", "2000000000"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid --max-bytes");
    const writer = await new DiskWriter(output, maxBytes).open();
    let candidates = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
      if (z === 6 && minZoom <= 5) index = makeIndex(false);
      console.log(`Generating z${z}…`);
      const n = 2 ** z;
      const xmin = Math.max(0, Math.floor(nw[0] * n));
      const xmax = Math.min(n - 1, Math.floor(se[0] * n));
      const ymin = Math.max(0, Math.floor(nw[1] * n));
      const ymax = Math.min(n - 1, Math.floor(se[1] * n));
      candidates += (xmax - xmin + 1) * (ymax - ymin + 1);
      if (candidates > 500000)
        throw new Error(
          "Prototype limited to 500,000 candidate tiles; use a smaller extract or lower max zoom",
        );
      for (let x = xmin; x <= xmax; x++)
        for (let y = ymin; y <= ymax; y++) {
          const tile = index.getTile(z, x, y);
          if (!tile) continue;
          const features = tile.features.filter(
            (f) => z >= displayMinZoom(f.tags ?? {}),
          );
          if (!features.length) continue;
          for (const part of splitTile(encodeTile(features)))
            await writer.add({
              key: `tile/${part.layer}/${z}/${x}/${y}`,
              z,
              x,
              y,
              features: part.features,
              bytes: part.bytes,
            });
          // Only source geometry is needed to split descendants. Release encoded tile geometry.
          tile.features = [];
          if (z === maxZoom)
            (tile as unknown as { source: unknown }).source = null;
        }
    }
    const encoder = new TextEncoder();
    await writer.add({
      key: "query/peaks",
      features: imported.peaks.length,
      bytes: encoder.encode(JSON.stringify(imported.peaks)),
    });
    if (!flags["no-source-features"])
      await writer.add({
        key: "features/geojson",
        features: imported.geojson.features.length,
        bytes: encoder.encode(JSON.stringify(imported.geojson)),
      });
    await writer.add({
      key: imported.routing.block,
      features: imported.routing.segments,
      bytes: new Uint8Array(
        await Bun.file(`${importedPath}.routing.bin`).arrayBuffer(),
      ),
    });
    console.log("Building search and street indexes…");
    const geocoding = buildGeocoding(imported.locations, imported.geojson);
    await writer.add({
      key: "search/locations",
      features: geocoding.locations.records.length,
      bytes: encoder.encode(JSON.stringify(geocoding.locations)),
    });
    await writer.add({
      key: "search/streets",
      features: geocoding.streets.streets.length,
      bytes: encoder.encode(JSON.stringify(geocoding.streets)),
    });
    console.log("Partitioning street labels and POIs…");
    const labels = partitionLabels(
      buildLabels(geocoding.locations, geocoding.streets),
    );
    for (const [key, block] of labels)
      await writer.add({
        key,
        features: block.roads.length + block.pois.length,
        bytes: encoder.encode(JSON.stringify(block)),
      });
    if (flags.features) {
      console.log("Partitioning selectable source geometry…");
      const cells = buildFeatures(imported.geojson);
      for (const [key, features] of cells) {
        await writer.add({
          key,
          features: features.length,
          bytes: encoder.encode(
            JSON.stringify({ schema: "features-v1", features }),
          ),
        });
        cells.delete(key);
      }
    }
    const sourceFile = Bun.file(`${input}.source.json`);
    const source = (await sourceFile.exists())
      ? await sourceFile.json()
      : { url: "local OSM PBF" };
    const hash = await fileHash(input);
    const size = await writer.finish({
      format: "atlas",
      version: 1,
      name: text(flags, "name", "Liechtenstein"),
      source: {
        url: source.url,
        sha256: hash,
        attribution: "© OpenStreetMap contributors · ODbL 1.0",
        ...(source.inputs
          ? { inputs: source.inputs, extraction: source.extraction }
          : {}),
      },
      bounds,
      minZoom,
      maxZoom,
      features: imported.geojson.features.length,
      tileLayers: [...MAP_LAYERS],
      peaks: imported.peaks.length,
      places: imported.places,
      routing: imported.routing,
      labelZoom: LABEL_ZOOM,
      ...(flags.features ? { featureZoom: FEATURE_ZOOM } : {}),
      areas: {
        assembledRelations: imported.assembledRelations,
        skippedRelations: imported.skippedRelations,
      },
      capabilities: [
        "vector-rendering",
        ...(flags.features ? ["feature-extraction"] : []),
        "map-labels",
        "walking-routing",
        "location-search",
        "reverse-street",
        "peak-query",
        ...(!flags["no-source-features"] ? ["source-feature-export"] : []),
      ],
      limitations: [
        "Experimental schema; no compatibility guarantee",
        `${imported.assembledRelations} area relations assembled; ${imported.skippedRelations} incomplete or unsupported area relations skipped. Nested relation members are not assembled.`,
        "Walking-v1 only: shortest distance, no turn relations, terrain/difficulty, live conditions, or country-specific access defaults",
        "Routing graph covers retained ways in the source extract; no route does not prove real-world disconnection",
        "Conditional access and unsupported access values are excluded; nearest-segment snapping is limited to 150 m",
        "Location search and nearest-street lookup only; no house-number address matching or authoritative administrative hierarchy",
        "Reverse lookup covers retained street types within 1 km; a nearest street is not a postal address or an accessible route",
        "No imagery, terrain, or Hashtree transport yet",
        `${imported.skippedWays} ways skipped because referenced nodes were missing`,
        "Peak query covers this source extract, which can extend beyond political borders",
      ],
    });
    report(
      {
        file: output,
        bytes: size,
        tileBlocks: writer.blocks.filter((b) => b.key.startsWith("tile/"))
          .length,
        features: imported.geojson.features.length,
        peaks: imported.peaks.length,
        routing: imported.routing,
        locations: geocoding.locations.records.length,
        streets: geocoding.streets.streets.length,
        sourceSha256: hash,
      },
      format,
    );
    return;
  }
  if (command === "inspect") {
    const file = Bun.file(resolve(text(flags, "input", DEFAULT_OUTPUT)));
    const header = parseHeader(
      new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer()),
    );
    const index = parseIndex(
      header,
      new Uint8Array(
        await file.slice(HEADER_SIZE, header.payloadOffset).arrayBuffer(),
      ),
    );
    report(
      {
        manifest: index.manifest,
        bytes: header.fileLength,
        blocks: index.blockCount,
        tileBlocks: index.tileCount,
      },
      format,
    );
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch((error) => {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
