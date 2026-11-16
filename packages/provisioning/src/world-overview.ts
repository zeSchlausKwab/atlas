import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import bboxClip from "@turf/bbox-clip";
import type {
  Feature,
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Point,
} from "geojson";
import { BoundaryWriter } from "../../boundaries/src/build";
import { StreamWriter } from "../../cli/src/stream-writer";
import { oceanTiles } from "../../cli/src/ocean-tiles";
import { AtlasReader, FileSource } from "../../format/src/reader";
import type { Manifest, Place } from "../../format/src/index";
import { familyCatalog } from "../../format/src/families";
import { encodePlaces } from "../../labels/src/places";
import { NO_SIZE_LIMIT } from "./capacity";
import type { PackageSelection, PreparationProgress } from "./selection";

export const NATURAL_EARTH_REVISION =
  "f1890d9f152c896d250a77557a5751a93d494776";
const base = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NATURAL_EARTH_REVISION}/geojson/`;
export const WORLD_INPUTS = [
  {
    name: "ne_50m_admin_0_countries",
    bytes: 3083490,
    sha256: "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
  },
  {
    name: "ne_50m_ocean",
    bytes: 1383426,
    sha256: "5b810162af4b20805838cfd766ef1a445c350cf6aafc8b589515daef30033adf",
  },
  {
    name: "ne_50m_lakes",
    bytes: 876018,
    sha256: "d350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52",
  },
  {
    name: "ne_50m_populated_places",
    bytes: 3350885,
    sha256: "da4662b7bbfeb897d02f228c5839131dce27acff5717630f91ccff4f67828ee7",
  },
].map((v) => ({ ...v, url: base + v.name + ".geojson" }));
export const WORLD_SOURCE_BYTES = WORLD_INPUTS.reduce((n, v) => n + v.bytes, 0);
export const WORLD_WORKSPACE_ALLOWANCE = 1024 ** 3;
const BOUNDS: [number, number, number, number] = [-180, -85, 180, 85];
const sha = (b: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(b).digest("hex");
export const WORLD_FINGERPRINT = sha(JSON.stringify(WORLD_INPUTS));
export function worldOverviewSelection(
  name: unknown = "World overview · Natural Earth",
): PackageSelection {
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    throw Error("Map name must contain 1–80 characters");
  return {
    name: name.trim(),
    snapshot: WORLD_FINGERPRINT,
    polygon: [
      [-180, -85],
      [180, -85],
      [180, 85],
      [-180, 85],
      [-180, -85],
    ],
    minZoom: 0,
    maxZoom: 6,
    layers: ["land", "water"],
    placeNames: true,
    streetNames: false,
    pois: false,
    profiles: [],
    search: false,
    reverse: false,
    peaks: false,
    featureKinds: ["boundaries"],
    boundaryMaxAdminLevel: 2,
    paddingCells: 0,
    maxBytes: NO_SIZE_LIMIT,
  };
}
/** Fixed public inputs only. Cached files are authenticated on every build. */
export async function worldInput(
  cache: string,
  input: (typeof WORLD_INPUTS)[number],
  signal: AbortSignal,
) {
  await mkdir(cache, { recursive: true });
  const path = join(cache, input.name + ".geojson"),
    file = Bun.file(path);
  signal.throwIfAborted();
  if (await file.exists()) {
    if (file.size === input.bytes) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (sha(bytes) === input.sha256)
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    await rm(path);
  }
  const response = await fetch(input.url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  });
  if (!response.ok || !response.body)
    throw Error(`Natural Earth download failed: HTTP ${response.status}`);
  const reader = response.body.getReader(),
    bytes = new Uint8Array(input.bytes);
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length)
        throw Error("Natural Earth source exceeds pinned size");
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel();
  }
  if (offset !== input.bytes || sha(bytes) !== input.sha256)
    throw Error("Natural Earth source hash mismatch");
  const data = JSON.parse(new TextDecoder().decode(bytes));
  await Bun.write(path + ".part", bytes);
  await rename(path + ".part", path);
  return data;
}
export function clipWorld(data: FeatureCollection<Polygon | MultiPolygon>) {
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("Invalid Natural Earth collection");
  const features: Feature<Polygon | MultiPolygon>[] = [];
  for (const feature of data.features) {
    if (
      !feature.geometry ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry.type)
    )
      throw Error("Expected polygon input");
    const clipped = bboxClip(feature, BOUNDS) as Feature<
      Polygon | MultiPolygon
    >;
    if (clipped.geometry.coordinates.length) features.push(clipped);
  }
  return { type: "FeatureCollection" as const, features };
}
export interface WorldData {
  countries: FeatureCollection<Polygon | MultiPolygon>;
  ocean: FeatureCollection<Polygon | MultiPolygon>;
  lakes: FeatureCollection<Polygon | MultiPolygon>;
  places: FeatureCollection<Point>;
}
/** Generalized overview only: no fabricated OSM identities or municipal detail. */
export async function compileWorldOverview(
  data: WorldData,
  output: string,
  name: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void = () => {},
) {
  const selection = worldOverviewSelection(name),
    countries = clipWorld(data.countries),
    water = clipWorld({
      type: "FeatureCollection",
      features: [...data.ocean.features, ...data.lakes.features],
    });
  const writer = await new StreamWriter(output, NO_SIZE_LIMIT).open();
  const started = performance.now();
  const progress = (
    stage: string,
    message: string,
    completed: number,
    total: number,
    unit: PreparationProgress["unit"] = "objects",
  ) =>
    report({
      phase: "compiling",
      stage,
      message,
      completed,
      total,
      unit,
      readBytes: WORLD_SOURCE_BYTES,
      writtenBytes: writer.bytesWritten,
      elapsedSeconds: (performance.now() - started) / 1000,
    });
  try {
    const boundaries = new BoundaryWriter(writer, 2);
    for (const [i, feature] of countries.features.entries()) {
      signal.throwIfAborted();
      const p = feature.properties!;
      if (!Number.isSafeInteger(p.NE_ID) || p.NE_ID < 0)
        throw Error("Missing Natural Earth country identity");
      const tags: Record<string, string> = {
        boundary: "administrative",
        admin_level: "2",
        source: "Natural Earth v5.1.2 / 1:50m",
        name: String(p.NAME_EN || p.ADMIN || p.NAME),
      };
      for (const k of [
        "ISO_A2",
        "ISO_A3",
        "ADM0_A3",
        "SOV_A3",
        "TYPE",
        "POP_EST",
        "POP_YEAR",
        "GDP_MD",
        "GDP_YEAR",
        "CONTINENT",
        "REGION_UN",
        "SUBREGION",
        "WIKIDATAID",
      ])
        if (p[k] !== null && p[k] !== undefined)
          tags[`ne:${k.toLowerCase()}`] = String(p[k]);
      await boundaries.add({
        ...feature,
        id: `natural-earth/admin-0/${p.NE_ID}`,
        properties: { name: tags.name, tags },
      });
      progress(
        "world-boundaries",
        "Retaining generalized country polygons",
        i + 1,
        countries.features.length,
      );
    }
    await boundaries.finish();
    const places: Place[] = data.places.features
      .filter(
        (f) =>
          f.geometry?.type === "Point" &&
          Math.abs(f.geometry.coordinates[1]!) <= 85,
      )
      .sort(
        (a, b) =>
          Number(b.properties?.POP_MAX || 0) -
          Number(a.properties?.POP_MAX || 0),
      )
      .map((f) => ({
        name: String(f.properties?.NAME_EN || f.properties?.NAME),
        coordinates: f.geometry.coordinates as [number, number],
      }));
    await writer.add({
      key: "labels/places",
      bytes: encodePlaces(places),
      features: places.length,
    });
    const manifest: Omit<Manifest, "snapshot"> = {
      format: "atlas",
      version: 1,
      name: selection.name,
      source: {
        url: "https://www.naturalearthdata.com/",
        sha256: WORLD_FINGERPRINT,
        attribution: "Made with Natural Earth · public domain · v5.1.2 · 1:50m",
        inputs: WORLD_INPUTS.map(({ url, sha256, bytes }) => ({
          url,
          sha256,
          bytes,
        })),
      },
      bounds: BOUNDS,
      minZoom: 0,
      maxZoom: 6,
      tileLayers: ["land", "water"],
      features: countries.features.length,
      peaks: 0,
      places: [],
      labelZoom: 12,
      featureZoom: 12,
      featureSchema: 2,
      featureKinds: ["boundaries"],
      capabilities: [
        "vector-rendering",
        "map-labels",
        "feature-extraction",
        "administrative-boundaries",
        "boundary-rendering",
      ],
      limitations: [
        "Generalized Natural Earth v5.1.2 data, not current OSM or legal boundary authority.",
        "Country and dependency polygons only; no regions, municipalities, addresses or routing.",
        "Display detail ends at zoom 6; coverage is clipped to ±85° latitude.",
        "Country polygons can be queried; simplified administrative outlines are available as a separate display layer.",
        "Population and GDP attributes are estimates from the source’s stated years, not live statistics.",
      ],
    };
    for (const [layer, collection] of [
      ["land", countries],
      ["water", water],
    ] as const) {
      let tiles = 0;
      progress(`world-${layer}`, `Tiling generalized ${layer}`, 0, 0, "blocks");
      await oceanTiles(
        collection,
        manifest,
        signal,
        async (block) => {
          await writer.add(block);
          progress(
            `world-${layer}`,
            `Tiling generalized ${layer}`,
            ++tiles,
            0,
            "blocks",
          );
        },
        layer,
      );
      progress(
        `world-${layer}`,
        `Tiled generalized ${layer}`,
        tiles,
        tiles,
        "blocks",
      );
    }
    manifest.families = familyCatalog(manifest);
    signal.throwIfAborted();
    const size = await writer.finish(
      manifest,
      async () => signal.throwIfAborted(),
      (stage, done, total) =>
        progress(
          `world-${stage}`,
          "Assembling world overview",
          done,
          total,
          "bytes",
        ),
    );
    const reader = await new AtlasReader(
      new FileSource(Bun.file(output)),
    ).open();
    try {
      for await (const block of reader.iterateBlocks()) {
        signal.throwIfAborted();
        await reader.block(block.key);
      }
      return { size, manifest: reader.index.manifest };
    } finally {
      reader.dispose();
    }
  } finally {
    await writer.abort();
  }
}
export async function buildWorldOverview(
  cache: string,
  output: string,
  name: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  const collections = [];
  for (const [i, input] of WORLD_INPUTS.entries()) {
    report({
      phase: "downloading",
      stage: "world-inputs",
      message: `Verifying Natural Earth source ${i + 1}/4: ${input.name}`,
      completed: i,
      total: 4,
      unit: "stages",
      readBytes: 0,
      writtenBytes: 0,
    });
    collections.push(await worldInput(cache, input, signal));
  }
  return compileWorldOverview(
    {
      countries: collections[0],
      ocean: collections[1],
      lakes: collections[2],
      places: collections[3],
    },
    output,
    name,
    signal,
    report,
  );
}
