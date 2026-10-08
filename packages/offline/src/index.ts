import {
  PLACE_LABEL_KEY,
  decodePlaces,
  encodePlaces,
} from "../../labels/src/places";
import { tileRecords, splitTile } from "../../format/src/tiles";
import { decodeLabels, type LabelBlock } from "../../labels/src/index";
import { AtlasReader } from "../../format/src/reader";
import {
  encodePagedIndex,
  describeBlock,
  type InputBlock,
} from "../../format/src/writer";
import {
  MAP_LAYERS,
  type MapLayer,
  unproject,
  project,
  type Block,
  type Manifest,
  type Peak,
} from "../../format/src/index";
import type {
  LocationBlock,
  StreetBlock,
  Street,
} from "../../geocoding/src/model";
import {
  bounds,
  inside,
  clipSegment,
  interpolate,
  intersectsRectangle,
  validatePolygon,
  type Polygon,
} from "./geometry";
import { clipGraph } from "./graph";
export interface Selection {
  polygon: Polygon;
  minZoom: number;
  maxZoom: number;
  routing: boolean;
  search: boolean;
  queries?: boolean;
  name: string;
  layers?: MapLayer[];
  placeNames?: boolean;
  streetNames?: boolean;
  pois?: boolean;
}
export async function plan(reader: AtlasReader, s: Selection) {
  validatePolygon(s.polygon);
  if (
    s.layers !== undefined &&
    (!Array.isArray(s.layers) ||
      s.layers.some((l) => !MAP_LAYERS.includes(l)) ||
      new Set(s.layers).size !== s.layers.length)
  )
    throw new Error("Invalid selected map layers");
  if (
    [s.placeNames, s.streetNames, s.pois].some(
      (v) => v !== undefined && typeof v !== "boolean",
    )
  )
    throw new Error("Invalid label selection");
  const m = reader.index.manifest;
  if (
    !Number.isInteger(s.minZoom) ||
    !Number.isInteger(s.maxZoom) ||
    s.minZoom < m.minZoom ||
    s.maxZoom > m.maxZoom ||
    s.minZoom > s.maxZoom
  )
    throw new Error("Choose zoom levels inside this package’s range.");
  const box = bounds(s.polygon),
    nw = project(box[0], box[3]),
    se = project(box[2], box[1]);
  const candidates: Block[] = [];
  for (let z = s.minZoom; z <= s.maxZoom; z++) {
    const n = 2 ** z;
    candidates.push(
      ...(await reader.tiles(
        z,
        Math.max(0, Math.floor(nw[0] * n)),
        Math.min(n - 1, Math.floor(se[0] * n)),
        Math.max(0, Math.floor(nw[1] * n)),
        Math.min(n - 1, Math.floor(se[1] * n)),
        s.layers,
      )),
    );
  }
  const tiles = candidates.filter((b) => {
    if (b.z === undefined || b.z < s.minZoom || b.z > s.maxZoom) return false;
    const n = 2 ** b.z,
      a = unproject(b.x! / n, (b.y! + 1) / n),
      c = unproject((b.x! + 1) / n, b.y! / n);
    return intersectsRectangle(s.polygon, [...a, ...c]);
  });
  const labelBlocks = reader.index.blocks.filter((b) => {
    if (!b.key.startsWith("labels/")) return false;
    if (b.key === PLACE_LABEL_KEY) return s.placeNames !== false;
    if (s.streetNames === false && s.pois === false) return false;
    if (b.key.includes("/roads/") && s.streetNames === false) return false;
    if (b.key.includes("/pois/") && s.pois === false) return false;
    const [, z, x, y] = b.key.split("/").map(Number),
      n = 2 ** z!;
    const a = unproject(x! / n, (y! + 1) / n),
      c = unproject((x! + 1) / n, y! / n);
    return intersectsRectangle(s.polygon, [...a, ...c]);
  });
  if (!tiles.length && !labelBlocks.length)
    throw new Error(
      "No selected map data intersects this area. Enable a layer or choose another area.",
    );
  const extra = reader.index.blocks.filter(
    (b) =>
      (s.queries && b.key === "query/peaks") ||
      (s.routing && b.key === "routing/walking") ||
      (s.search && b.key.startsWith("search/")),
  );
  return {
    tiles,
    labelBlocks,
    bytes: [...tiles, ...labelBlocks, ...extra].reduce(
      (sum, b) => sum + b.length,
      0,
    ),
    tileBytes: tiles.reduce((sum, b) => sum + b.length, 0),
  };
}
export async function extract(
  reader: AtlasReader,
  s: Selection,
  progress: (message: string) => void = () => {},
): Promise<Blob> {
  const selection = await plan(reader, s),
    m = reader.index.manifest;
  if (selection.tileBytes > 256_000_000)
    throw new Error(
      "Choose a smaller area: this browser demo allows 256 MB of selected display tiles.",
    );
  const blocks: Block[] = [],
    parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const buildingHeights = { tagged: 0, estimated: 0, missing: 0, maxMeters: 0 };
  async function add(input: InputBlock) {
    if (m.buildingHeights && input.key.startsWith("tile/"))
      for (const r of tileRecords(input.bytes))
        if (r.class === 2) {
          const h = r.height;
          buildingHeights[
            h && (h.source & 3) === 1
              ? "tagged"
              : h && (h.source & 3) === 2
                ? "estimated"
                : "missing"
          ]++;
          buildingHeights.maxMeters = Math.max(
            buildingHeights.maxMeters,
            h?.height ?? 0,
            h?.minHeight ?? 0,
          );
        }
    const compressed = new Uint8Array(
      await new Response(
        new Blob([input.bytes as Uint8Array<ArrayBuffer>])
          .stream()
          .pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const stored =
      compressed.length < input.bytes.length
        ? {
            ...input,
            bytes: compressed,
            codec: "gzip" as const,
            rawLength: input.bytes.length,
          }
        : input;
    blocks.push(await describeBlock(stored, offset));
    parts.push(stored.bytes as Uint8Array<ArrayBuffer>);
    offset += stored.bytes.length;
    if (offset > 256_000_000)
      throw new Error(
        "Offline package exceeds the 256 MB browser export limit.",
      );
  }
  for (let i = 0; i < selection.tiles.length; i++) {
    const b = selection.tiles[i]!;
    if (i % 20 === 0)
      progress(`Packing tiles ${i + 1} / ${selection.tiles.length}…`);
    const bytes = await reader.block(b.key);
    if (s.layers && !m.tileLayers) {
      for (const part of splitTile(bytes))
        if (s.layers.includes(part.layer))
          await add({
            key: `tile/${part.layer}/${b.z}/${b.x}/${b.y}`,
            z: b.z,
            x: b.x,
            y: b.y,
            features: part.features,
            bytes: part.bytes,
          });
    } else
      await add({
        key: b.key,
        z: b.z,
        x: b.x,
        y: b.y,
        features: b.features,
        bytes,
      });
    reader.cache.delete(b.key);
  }
  const json = async (key: string) =>
    JSON.parse(new TextDecoder().decode(await reader.block(key)));
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const capabilities = ["vector-rendering"];
  if (
    m.capabilities.includes("building-heights") &&
    buildingHeights.tagged +
      buildingHeights.estimated +
      buildingHeights.missing >
      0
  )
    capabilities.push("building-heights");
  if (m.capabilities.includes("map-labels")) {
    progress("Packing street names and points of interest…");
    for (const b of selection.labelBlocks) {
      if (b.key === PLACE_LABEL_KEY) {
        const places = decodePlaces(await reader.block(b.key)).filter((p) =>
          inside(p.coordinates, s.polygon),
        );
        if (places.length)
          await add({
            key: b.key,
            features: places.length,
            bytes: encodePlaces(places),
          });
        reader.cache.delete(b.key);
        continue;
      }
      const source = decodeLabels(await reader.block(b.key));
      const clipped: LabelBlock = {
        schema: "labels-v1",
        pois:
          s.pois === false
            ? []
            : source.pois.filter((p) => inside(p.coordinates, s.polygon)),
        roads: [],
      };
      for (const road of s.streetNames === false ? [] : source.roads) {
        let part: typeof road | undefined;
        for (let i = 1; i < road.coordinates.length; i++) {
          const a = road.coordinates[i - 1]!,
            end = road.coordinates[i]!,
            intervals = clipSegment(a, end, s.polygon);
          if (!intervals.length) part = undefined;
          for (const [lo, hi] of intervals) {
            const start = interpolate(a, end, lo),
              finish = interpolate(a, end, hi),
              last = part?.coordinates.at(-1);
            if (
              part &&
              last &&
              Math.hypot(last[0] - start[0], last[1] - start[1]) < 1e-12
            )
              part.coordinates.push(finish);
            else {
              part = { ...road, coordinates: [start, finish] };
              clipped.roads.push(part);
            }
            if (hi < 1) part = undefined;
          }
        }
      }
      if (clipped.roads.length || clipped.pois.length)
        await add({
          key: b.key,
          features: clipped.roads.length + clipped.pois.length,
          bytes: encode(clipped),
        });
      reader.cache.delete(b.key);
    }
    if (blocks.some((b) => b.key.startsWith("labels/")))
      capabilities.push("map-labels");
  }
  let routing: Manifest["routing"];
  let peaks: Peak[] = [];
  if (s.queries && m.capabilities.includes("peak-query")) {
    peaks = ((await json("query/peaks")) as Peak[]).filter((p) =>
      inside(p.coordinates, s.polygon),
    );
    await add({
      key: "query/peaks",
      bytes: encode(peaks),
      features: peaks.length,
    });
    capabilities.push("peak-query");
  }
  if (s.routing && m.routing) {
    progress("Cutting the walking graph to your boundary…");
    const graph = clipGraph(await reader.block(m.routing.block), s.polygon);
    routing = {
      ...m.routing,
      nodes: graph.nodes,
      segments: graph.segments,
      bytes: graph.bytes.length,
      skippedWays: 0,
    };
    delete routing.cells; // Child exports carry their clipped reference graph, not parent cells.
    await add({
      key: routing.block,
      bytes: graph.bytes,
      features: graph.segments,
    });
    capabilities.push("walking-routing");
    reader.cache.delete(m.routing.block);
  }
  if (s.search && m.capabilities.includes("location-search")) {
    progress("Selecting places and streets…");
    const locations = (await json("search/locations")) as LocationBlock;
    locations.records = locations.records.filter((r) =>
      inside(r.coordinates, s.polygon),
    );
    await add({
      key: "search/locations",
      bytes: encode(locations),
      features: locations.records.length,
    });
    capabilities.push("location-search");
    if (m.capabilities.includes("reverse-street")) {
      const streets = (await json("search/streets")) as StreetBlock,
        clipped: Street[] = [];
      for (const street of streets.streets) {
        let part: Street | undefined;
        for (let i = 1; i < street.coordinates.length; i++) {
          const a = street.coordinates[i - 1]!,
            b = street.coordinates[i]!;
          const intervals = clipSegment(a, b, s.polygon);
          if (!intervals.length) part = undefined;
          for (const [lo, hi] of intervals) {
            const start = interpolate(a, b, lo),
              end = interpolate(a, b, hi),
              last = part?.coordinates.at(-1);
            if (
              part &&
              last &&
              Math.hypot(last[0] - start[0], last[1] - start[1]) < 1e-12
            )
              part.coordinates.push(end);
            else {
              part = { ...street, coordinates: [start, end] };
              clipped.push(part);
            }
            if (hi < 1) part = undefined;
          }
        }
      }
      await add({
        key: "search/streets",
        bytes: encode({ schema: "streets-v1", streets: clipped }),
        features: clipped.length,
      });
      capabilities.push("reverse-street");
    }
  }
  const manifest: Omit<Manifest, "snapshot"> = {
    ...m,
    name: s.name.trim() || "My offline world",
    bounds: bounds(s.polygon),
    minZoom: s.minZoom,
    maxZoom: s.maxZoom,
    features: blocks
      .filter((b) => b.key.startsWith("tile/"))
      .reduce((n, b) => n + b.features, 0),
    tileLayers: s.layers ?? m.tileLayers,
    featureCountKind: "tile-records",
    peaks: peaks.length,
    ...(m.buildingHeights ? { buildingHeights } : {}),
    places:
      s.placeNames === false
        ? []
        : m.places.filter((p) => inside(p.coordinates, s.polygon)),
    routing,
    capabilities,
    selection: {
      polygon: s.polygon,
      parentSnapshot: m.snapshot,
      boundaryPolicy:
        "intersecting-display-tiles; clipped-routing-and-streets; interior-search-points",
    },
    limitations: [
      ...m.limitations,
      "Display tiles retain geometry outside the drawn boundary. Routes and reverse-street segments are cut at the boundary; forward search retains interior representative points.",
    ],
  };
  delete (manifest as Partial<Manifest>).snapshot;
  const { prefix, pages } = await encodePagedIndex(manifest, blocks, offset);
  if (
    prefix.length + offset + pages.reduce((n, p) => n + p.length, 0) >
    256_000_000
  )
    throw new Error("Offline package exceeds the 256 MB browser export limit.");
  progress("Offline world ready.");
  return new Blob([prefix, ...parts, ...pages], {
    type: "application/octet-stream",
  });
}
