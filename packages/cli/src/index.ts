#!/usr/bin/env bun
import { compilerWorkers } from "../../compiler/src/settings";
import { compilePartitioned } from "./partitioned";
import { WORLD_SOURCE } from "../../provisioning/src/global-source";
import {
  validateSelectionScope,
  type PackageSelection,
} from "../../provisioning/src/selection";
import { addTransport, upgradeTransport } from "./transport";
import { copyTransport } from "./shared-transport";
import { PLACE_LABEL_KEY, encodePlaces } from "../../labels/src/places";
import { encodeTile } from "./tile-codec";
import { buildingHeight } from "../../format/src/heights";
import { MAP_LAYERS, layerForClass } from "../../format/src/index";
import { splitTile } from "../../format/src/tiles";
import { partitionPackageRouting } from "./routing-cells";
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
    "partitioned",
    "features",
  ]);
  const allowed = new Set([
    "url",
    "out",
    "input",
    "pbf",
    "output",
    "name",
    "min-zoom",
    "max-zoom",
    "max-bytes",
    "format",
    "sha256",
    "selection",
    "transport-from",
    "workers",
    "bounds",
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
async function main() {
  const { command, flags } = args(process.argv.slice(2));
  const format = text(flags, "format", "md");
  if (!["md", "json"].includes(format))
    throw new Error("--format must be md or json");
  if (command === "help" || flags.help) {
    console.log(
      `ATLAS prototype compiler\n\nUsage:\n  bun run cli fetch [--url URL] [--out FILE] [--sha256 HASH] [--dry-run]\n  bun run cli generate [--input FILE.osm.pbf] [--output FILE.atlas]\n                       [--name NAME] [--min-zoom 9] [--max-zoom 14] [--dry-run]\n                       [--max-bytes 2000000000] [--no-source-features] [--features]\n                       [--bounds W,S,E,N] [--selection recipe.json] [--partitioned] [--workers 1..8]\n  bun run cli split-layers --input FILE.atlas [--output FILE.atlas]\n  bun run cli transport --input FILE.atlas --pbf FILE.osm.pbf [--output FILE.atlas]\n  bun run cli routing-cells --input FILE.atlas [--output FILE.atlas]\n  bun run cli inspect [--input FILE.atlas]\n\nAll commands support --format md|json and --flag=value. Defaults use Liechtenstein.\n--features adds optional spatial source geometry for selection and GeoJSON export.\n--partitioned requires a selection recipe; disk-backed stages resume from OUTPUT.work.\nThe generator requires Cargo. Rust/WASM compilation is a separate bun run build:wasm step.`,
    );
    return;
  }
  if (command === "transport") {
    const input = resolve(text(flags, "input", DEFAULT_OUTPUT)),
      output = resolve(text(flags, "output", input));
    const pbf = resolve(text(flags, "pbf", DEFAULT_INPUT));
    const maxBytes = Number(text(flags, "max-bytes", "2000000000"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid --max-bytes");
    if (flags["dry-run"]) report({ input, output, pbf, maxBytes }, format);
    else report(await upgradeTransport(input, pbf, output, maxBytes), format);
    return;
  }
  if (command === "routing-cells") {
    const input = resolve(text(flags, "input", DEFAULT_OUTPUT)),
      output = resolve(text(flags, "output", input));
    const maxBytes = Number(text(flags, "max-bytes", "2000000000"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid --max-bytes");
    if (flags["dry-run"])
      report({ action: "partition-routing", input, output, maxBytes }, format);
    else report(await partitionPackageRouting(input, output, maxBytes), format);
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
    if (flags.workers !== undefined && !flags.partitioned)
      throw new Error("--workers requires --partitioned");
    const workers = flags.partitioned
      ? compilerWorkers(flags.workers)
      : undefined;
    if (flags["dry-run"]) {
      report(
        { action: "generate", input, output, minZoom, maxZoom, workers },
        format,
      );
      return;
    }
    if (!(await Bun.file(input).exists()))
      throw new Error(`Missing source ${input}; run bun run data:fetch`);
    await mkdir(dirname(output), { recursive: true });
    const selected: PackageSelection | undefined = flags.selection
      ? await Bun.file(text(flags, "selection", "")).json()
      : undefined;
    if (selected) validateSelectionScope(selected, WORLD_SOURCE);
    if (flags["transport-from"] && !selected)
      throw new Error(
        "--transport-from requires --selection to define graph coverage",
      );
    const requestedBounds = flags.bounds
      ? text(flags, "bounds", "").split(",").map(Number)
      : undefined;
    if (
      requestedBounds &&
      (requestedBounds.length !== 4 ||
        !requestedBounds.every(Number.isFinite) ||
        requestedBounds[0]! >= requestedBounds[2]! ||
        requestedBounds[1]! >= requestedBounds[3]! ||
        requestedBounds[0]! < -180 ||
        requestedBounds[2]! > 180 ||
        requestedBounds[1]! < -85 ||
        requestedBounds[3]! > 85)
    )
      throw new Error("Invalid --bounds");
    if (flags.partitioned) {
      if (!selected)
        throw new Error("--partitioned requires --selection recipe.json");
      const build = Bun.spawn(
        [
          "cargo",
          "build",
          "--release",
          "--locked",
          "-p",
          "atlas-osm-import",
          "--bins",
        ],
        { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
      );
      if ((await build.exited) !== 0)
        throw new Error("Native compiler build failed");
      const abort = new AbortController();
      const stop = () =>
        abort.abort(
          new Error(
            "Build interrupted; rerun the same command to resume saved stages",
          ),
        );
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        await compilePartitioned({
          input,
          output,
          work: output + ".work",
          selection: selected,
          workers,
          signal: abort.signal,
        });
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      return;
    }
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
        ...(selected ? ["--no-legacy-routing"] : []),
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
    const buildingHeights = {
      tagged: 0,
      estimated: 0,
      missing: 0,
      maxMeters: 0,
    };
    for (const f of imported.geojson.features)
      if (f.properties?.class === 2) {
        const h = buildingHeight(f.properties.tags);
        buildingHeights[
          (h.source & 3) === 1
            ? "tagged"
            : (h.source & 3) === 2
              ? "estimated"
              : "missing"
        ]++;
        buildingHeights.maxMeters = Math.max(
          buildingHeights.maxMeters,
          h.height,
          h.minHeight,
        );
      }
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
    if (requestedBounds) bounds.splice(0, 4, ...requestedBounds);
    console.log(`Indexing ${imported.geojson.features.length} features…`);
    // Preserve the small regional footprint in world overviews. At normal map
    // scales, a half-pixel tolerance avoids shipping invisible vertex detail.
    const displayFeatures = imported.geojson.features.filter(
      (f) =>
        !selected ||
        selected.layers.includes(
          layerForClass(Number(f.properties?.class ?? 3)),
        ),
    );
    const makeIndex = (overview: boolean) =>
      geojsonvt(
        overview
          ? {
              ...imported.geojson,
              features: displayFeatures.filter(
                (f) => displayMinZoom(f.properties ?? {}) <= 5,
              ),
            }
          : { ...imported.geojson, features: displayFeatures },
        {
          maxZoom,
          extent: TILE_EXTENT,
          buffer: 0,
          tolerance: overview ? 5 : TILE_EXTENT / 512,
          indexMaxZoom: overview ? 0 : Math.min(maxZoom, 5),
          indexMaxPoints: 100000,
        },
      );
    let index =
      selected && !selected.layers.length ? undefined : makeIndex(minZoom <= 5);
    const nw = project(bounds[0], bounds[3]);
    const se = project(bounds[2], bounds[1]);
    const maxBytes = Number(text(flags, "max-bytes", "2000000000"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid --max-bytes");
    const writer = await new DiskWriter(output, maxBytes).open();
    let candidates = 0;
    if (index)
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
              (f) =>
                z >= displayMinZoom(f.tags ?? {}) &&
                (!selected ||
                  selected.layers.includes(
                    layerForClass(Number(f.tags?.class ?? 3)),
                  )),
            );
            if (!features.length) continue;
            for (const part of splitTile(encodeTile(features)))
              if (!selected || selected.layers.includes(part.layer))
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
    if (!selected || selected.placeNames)
      await writer.add({
        key: PLACE_LABEL_KEY,
        features: imported.places.length,
        bytes: encodePlaces(imported.places),
      });
    if (!selected || selected.peaks)
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
    if (!selected)
      await writer.add({
        key: imported.routing.block,
        features: imported.routing.segments,
        bytes: new Uint8Array(
          await Bun.file(`${importedPath}.routing.bin`).arrayBuffer(),
        ),
      });
    const transport =
      !selected || selected.profiles.length
        ? flags["transport-from"]
          ? await copyTransport(
              writer,
              resolve(text(flags, "transport-from", "")),
              selected!,
            )
          : await addTransport(writer, input, selected?.profiles)
        : undefined;
    console.log("Building search and street indexes…");
    const geocoding =
      !selected ||
      selected.search ||
      selected.reverse ||
      selected.streetNames ||
      selected.pois
        ? buildGeocoding(imported.locations, imported.geojson)
        : undefined;
    if (!selected || selected.search)
      await writer.add({
        key: "search/locations",
        features: geocoding!.locations.records.length,
        bytes: encoder.encode(JSON.stringify(geocoding!.locations)),
      });
    if (!selected || selected.reverse)
      await writer.add({
        key: "search/streets",
        features: geocoding!.streets.streets.length,
        bytes: encoder.encode(JSON.stringify(geocoding!.streets)),
      });
    if (!selected || selected.streetNames || selected.pois) {
      console.log("Partitioning street labels and POIs…");
      const labels = partitionLabels(
        buildLabels(geocoding!.locations, geocoding!.streets),
      );
      for (const [key, block] of labels)
        if (
          !selected ||
          (key.includes("/roads/") ? selected.streetNames : selected.pois)
        )
          await writer.add({
            key,
            features: block.roads.length + block.pois.length,
            bytes: encoder.encode(JSON.stringify(block)),
          });
    }
    if (flags.features) {
      console.log("Partitioning selectable source geometry…");
      const cells = buildFeatures(imported.geojson);
      for (const [key, features] of cells) {
        if (
          !selected ||
          selected.featureKinds.includes(key.split("/")[1] as any)
        )
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
      tileLayers: selected?.layers ?? [...MAP_LAYERS],
      buildingHeights:
        !selected || selected.layers.includes("buildings")
          ? buildingHeights
          : undefined,
      peaks: !selected || selected.peaks ? imported.peaks.length : 0,
      places: [],
      routing: selected ? undefined : imported.routing,
      transport,
      labelZoom:
        !selected ||
        selected.placeNames ||
        selected.streetNames ||
        selected.pois
          ? LABEL_ZOOM
          : undefined,
      ...(flags.features
        ? {
            featureZoom: FEATURE_ZOOM,
            ...(selected ? { featureKinds: selected.featureKinds } : {}),
          }
        : {}),
      areas: {
        assembledRelations: imported.assembledRelations,
        skippedRelations: imported.skippedRelations,
      },
      capabilities: [
        ...(!selected || selected.layers.length ? ["vector-rendering"] : []),
        ...(!selected || selected.layers.includes("buildings")
          ? ["building-heights"]
          : []),
        ...(flags.features ? ["feature-extraction"] : []),
        ...(!selected ||
        selected.placeNames ||
        selected.streetNames ||
        selected.pois
          ? ["map-labels"]
          : []),
        ...(!selected ? ["walking-routing"] : []),
        ...(transport ? ["transport-routing"] : []),
        ...(!selected || selected.search ? ["location-search"] : []),
        ...(!selected || selected.reverse ? ["reverse-street"] : []),
        ...(!selected || selected.peaks ? ["peak-query"] : []),
        ...(!flags["no-source-features"] ? ["source-feature-export"] : []),
      ],
      limitations: [
        "Experimental schema; no compatibility guarantee",
        `${imported.assembledRelations} area relations assembled; ${imported.skippedRelations} incomplete or unsupported area relations skipped. Nested multipolygon members are expanded with composed inner/outer roles.`,
        "Transport-v1: estimated times and common via-node turn restrictions; unsupported conditional/complex turn restrictions exclude incoming ways. No traffic, elevation costs, transit schedules or country-specific defaults",
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
        locations: geocoding?.locations.records.length ?? 0,
        streets: geocoding?.streets.streets.length ?? 0,
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
