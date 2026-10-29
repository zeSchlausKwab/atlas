import {
  validateComposition,
  MEMBER_CHUNK_BYTES,
  type ArchiveComposition,
} from "./composition-schema";
import { validateFamilies, type DataFamily } from "./families";
import { validateRasters, type RasterLayer } from "./raster";
import { pagedZoom } from "../../geocoding/src/paging";
/** ATLAS v0.1: immutable single-file package with independently addressed blocks. */
export const MAGIC = "ATLAS001";
export const HEADER_SIZE = 32;
export const TILE_EXTENT = 65535;
export const MAP_LAYERS = [
  "land",
  "water",
  "buildings",
  "roads",
  "railways",
  "peaks",
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];
export const LAYER_MASKS: Record<MapLayer, number> = {
  land: 1,
  water: 2,
  buildings: 4,
  roads: 56,
  railways: 64,
  peaks: 128,
};
export function layerForClass(cls: number): MapLayer {
  const layer = [
    "land",
    "water",
    "buildings",
    "roads",
    "roads",
    "roads",
    "railways",
    "peaks",
  ][cls];
  if (!layer) throw new Error("Invalid tile class");
  return layer as MapLayer;
}
export function tileLayer(key: string): MapLayer | undefined {
  const layer = key.split("/")[1];
  return key.startsWith("tile/") && MAP_LAYERS.includes(layer as MapLayer)
    ? (layer as MapLayer)
    : undefined;
}
export function isTilePrefix(prefix: string) {
  return prefix === "tile" || prefix.startsWith("tile/");
}
export const MAX_METADATA = 64 * 1024 * 1024;
export interface Peak {
  id: string;
  name: string;
  coordinates: [number, number];
  elevation: number | null;
}
export interface Place {
  name: string;
  coordinates: [number, number];
}
export const TRANSPORT_MODES = ["walking", "cycling", "driving"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export interface TransportProfile {
  prefix: string;
  zoom: 14;
  count: number;
  codec: "rcl2";
  nodes: number;
  segments: number;
  turns: number;
  skippedWays: number;
  unsupportedRestrictions: number;
  excludedRestrictionWays: number;
}
export interface TransportMetadata {
  version: 1;
  /** Identity of the compiled graph whose cells are copied unchanged into excerpts. */
  graphSnapshot?: string;
  profiles: Partial<Record<TransportMode, TransportProfile>>;
  statistics?: "cell-records";
}
export function isRoutingCell(key: string) {
  return /^routing\/(?:walking\/|cycling\/|driving\/)?cells\//.test(key);
}
function routingZoom(manifest: Manifest, prefix: string) {
  return prefix === "routing/cells"
    ? manifest.routing?.cells?.zoom
    : Object.values(manifest.transport?.profiles ?? {}).find(
        (p) => p.prefix === prefix,
      )?.zoom;
}
export interface RoutingMetadata {
  cells?: { zoom: 14; count: number; codec: "rcl1" };
  profile: "walking-v1";
  block: "routing/walking";
  nodes: number;
  segments: number;
  bytes: number;
  skippedWays: number;
  snapLimitMeters: 150;
  scope: "retained-source-extract";
}
export interface Manifest {
  format: "atlas";
  version: 1;
  name: string;
  source: {
    url: string;
    sha256: string;
    attribution: string;
    inputs?: Array<{ url: string; sha256: string; bytes: number }>;
    extraction?: { bounds: number[]; strategy: string; sourceDate: string };
  };
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  features: number;
  peaks: number;
  places: Place[];
  capabilities: string[];
  limitations: string[];
  snapshot: string;
  routing?: RoutingMetadata;
  transport?: TransportMetadata;
  labelZoom?: number;
  featureZoom?: number;
  /** Version 2 separates bounded attributes and geometry pages within the archive. */
  featureSchema?: 2;
  featureKinds?: (
    | "buildings"
    | "water"
    | "railways"
    | "roads"
    | "land"
    | "boundaries"
    | "objects"
  )[];
  tileLayers?: MapLayer[];
  rasters?: RasterLayer[];
  families?: DataFamily[];
  composition?: ArchiveComposition;
  buildingHeights?: {
    tagged: number;
    estimated: number;
    missing: number;
    maxMeters: number;
  };
  areas?: { assembledRelations: number; skippedRelations: number };
  featureCountKind?: "tile-records";
  semantics?: {
    version: 1;
    addresses: "osm-explicit";
    poiTags: boolean;
    administrativeHierarchy: boolean;
  };
  /** Immutable revision lineage; payload families remain self-contained. */
  amendment?: {
    version: 1;
    parentSnapshot: string;
    sourceSnapshot: string;
    builder: string;
    addedFamilies: string[];
    routingPaddingCells: number;
  };
  selection?: {
    polygon: [number, number][];
    parentSnapshot: string;
    boundaryPolicy: string;
    routingPaddingCells?: number;
  };
}
export interface Block {
  key: string;
  offset: number;
  length: number;
  hash: string;
  features: number;
  codec?: "gzip";
  rawLength?: number;
  z?: number;
  x?: number;
  y?: number;
}
export const INDEX_PAGE_SIZE = 32;
export function spatialAddress(key: string) {
  const label =
    /^labels\/(\d+)\/(\d+)\/(\d+)\/(roads|pois)\/(13|14|15|16|17)$/.exec(key);
  if (label)
    return {
      prefix: `labels/${label[4]}/${label[5]}`,
      z: Number(label[1]),
      x: Number(label[2]),
      y: Number(label[3]),
    };
  const m =
    /^(tile(?:\/(?:land|water|buildings|roads|railways|peaks))?|members\/m[0-9]{1,3}|raster\/[a-z][a-z0-9_-]{0,63}|features\/(?:buildings|water|railways|roads|land|attributes|geometry)|boundaries\/(?:records|geometry)|objects\/(?:geometry|topology|records|spatial|ids|lookup|tag-values|tag-index|tag-pages)|search\/(?:records|postings|terms|streets-data|locations-data|location-pages|street-pages)|labels\/settlements|query\/peaks-data|routing\/(?:(?:walking|cycling|driving)\/)?cells)\/(\d+)\/(\d+)\/(\d+)$/.exec(
      key,
    );
  return m
    ? { prefix: m[1]!, z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) }
    : null;
}
export function pageKey(prefix: string, z: number, x: number, y: number) {
  return `index/${prefix === "tile" ? "tiles" : prefix}/${z}/${x}/${y}`;
}
export interface IndexPage extends Block {
  prefix?: string;
  z: number;
  x: number;
  y: number;
  count: number;
}
export interface Header {
  version: 1 | 2;
  manifestLength: number;
  directoryLength: number;
  payloadOffset: number;
  fileLength: number;
}
export interface PackageIndex {
  header: Header;
  manifest: Manifest;
  /** Root entries only in v2. Use reader.tiles() or reader.allBlocks(). */
  blocks: Block[];
  pages: IndexPage[];
  /** Display blocks; a spatial tile can have multiple independently stored layers. */
  tileCount: number;
  blockCount: number;
}
const decoder = new TextDecoder();
export function parseHeader(bytes: Uint8Array): Header {
  if (
    bytes.byteLength !== HEADER_SIZE ||
    decoder.decode(bytes.subarray(0, 8)) !== MAGIC
  )
    throw new Error("Not an ATLAS package");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (![1, 2].includes(view.getUint32(8, true)))
    throw new Error("Unsupported ATLAS version");
  const header: Header = {
    version: view.getUint32(8, true) as 1 | 2,
    manifestLength: view.getUint32(12, true),
    directoryLength: view.getUint32(16, true),
    payloadOffset: view.getUint32(20, true),
    fileLength: Number(view.getBigUint64(24, true)),
  };
  if (
    header.manifestLength + header.directoryLength > MAX_METADATA ||
    header.payloadOffset !==
      HEADER_SIZE + header.manifestLength + header.directoryLength ||
    !Number.isSafeInteger(header.fileLength) ||
    header.fileLength < header.payloadOffset
  )
    throw new Error("Invalid ATLAS header bounds");
  return header;
}
export function parseIndex(header: Header, bytes: Uint8Array): PackageIndex {
  if (bytes.length !== header.payloadOffset - HEADER_SIZE)
    throw new Error("Truncated ATLAS index");
  const manifest = JSON.parse(
    decoder.decode(bytes.subarray(0, header.manifestLength)),
  ) as Manifest;
  const directory = JSON.parse(
    decoder.decode(bytes.subarray(header.manifestLength)),
  );
  const blocks: Block[] = header.version === 1 ? directory : directory.blocks;
  const pages: IndexPage[] = header.version === 1 ? [] : directory.pages;
  if (!Array.isArray(pages)) throw new Error("Invalid ATLAS directory pages");
  if (
    manifest.format !== "atlas" ||
    manifest.version !== 1 ||
    typeof manifest.name !== "string" ||
    !Array.isArray(manifest.bounds) ||
    manifest.bounds.length !== 4 ||
    !manifest.bounds.every(Number.isFinite) ||
    !Number.isInteger(manifest.minZoom) ||
    !Number.isInteger(manifest.maxZoom) ||
    manifest.minZoom < 0 ||
    manifest.maxZoom > 18 ||
    manifest.minZoom > manifest.maxZoom ||
    !Array.isArray(manifest.places) ||
    !Array.isArray(manifest.capabilities) ||
    !Array.isArray(blocks)
  )
    throw new Error("Invalid ATLAS manifest");
  if (
    typeof manifest.snapshot !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.snapshot) ||
    !Number.isSafeInteger(manifest.features) ||
    manifest.features < 0 ||
    !Number.isSafeInteger(manifest.peaks) ||
    manifest.peaks < 0 ||
    !manifest.capabilities.every((c) => typeof c === "string") ||
    !manifest.places.every(
      (p) =>
        p &&
        typeof p.name === "string" &&
        Array.isArray(p.coordinates) &&
        p.coordinates.length === 2 &&
        p.coordinates.every(Number.isFinite),
    ) ||
    manifest.bounds[0] >= manifest.bounds[2] ||
    manifest.bounds[1] >= manifest.bounds[3] ||
    manifest.bounds[0] < -180 ||
    manifest.bounds[2] > 180 ||
    manifest.bounds[1] < -90 ||
    manifest.bounds[3] > 90
  )
    throw new Error("Invalid ATLAS metadata");
  if (
    manifest.tileLayers !== undefined &&
    (!Array.isArray(manifest.tileLayers) ||
      manifest.tileLayers.some((l) => !MAP_LAYERS.includes(l)) ||
      new Set(manifest.tileLayers).size !== manifest.tileLayers.length)
  )
    throw new Error("Invalid map layer catalog");
  validateComposition(manifest.composition);
  if (
    manifest.capabilities.includes("map-composition") !== !!manifest.composition
  )
    throw new Error("Composition capability mismatch");
  validateRasters(manifest.rasters);
  validateFamilies(manifest.families);
  if (
    manifest.capabilities.includes("raster-rendering") !==
    !!manifest.rasters?.length
  )
    throw new Error("Raster capability mismatch");
  if (manifest.buildingHeights) {
    const h = manifest.buildingHeights;
    if (
      ![h.tagged, h.estimated, h.missing].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      !Number.isFinite(h.maxMeters) ||
      h.maxMeters < 0 ||
      h.maxMeters > 2000
    )
      throw new Error("Invalid building height metadata");
  }
  if (manifest.capabilities.includes("map-labels") && manifest.labelZoom !== 12)
    throw new Error("Invalid label grid");
  if (
    manifest.capabilities.includes("feature-extraction") &&
    manifest.featureZoom !== 12
  )
    throw new Error("Invalid feature grid");
  if (
    manifest.featureSchema !== undefined &&
    (manifest.featureSchema !== 2 ||
      !manifest.capabilities.includes("feature-extraction"))
  )
    throw new Error("Invalid feature schema");
  if (manifest.amendment) {
    const a = manifest.amendment;
    if (
      a.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(a.parentSnapshot) ||
      !/^[a-f0-9]{64}$/.test(a.sourceSnapshot) ||
      typeof a.builder !== "string" ||
      !a.builder ||
      !Array.isArray(a.addedFamilies) ||
      !a.addedFamilies.length ||
      a.addedFamilies.some((f) => typeof f !== "string" || !f) ||
      !Number.isInteger(a.routingPaddingCells) ||
      a.routingPaddingCells < 0 ||
      a.routingPaddingCells > 4
    )
      throw new Error("Invalid amendment provenance");
  }
  if (manifest.selection) {
    const s = manifest.selection;
    if (
      !Array.isArray(s.polygon) ||
      s.polygon.length < 3 ||
      s.polygon.length > 128 ||
      !s.polygon.every(
        (p) =>
          Array.isArray(p) &&
          p.length === 2 &&
          p.every(Number.isFinite) &&
          Math.abs(p[0]) <= 180 &&
          Math.abs(p[1]) <= 85,
      ) ||
      typeof s.parentSnapshot !== "string" ||
      !/^[a-f0-9]{64}$/.test(s.parentSnapshot) ||
      typeof s.boundaryPolicy !== "string"
    )
      throw new Error("Invalid selection metadata");
  }
  if (
    manifest.featureKinds &&
    (!Array.isArray(manifest.featureKinds) ||
      new Set(manifest.featureKinds).size !== manifest.featureKinds.length ||
      manifest.featureKinds.some(
        (k) =>
          ![
            "buildings",
            "water",
            "railways",
            "roads",
            "land",
            "boundaries",
            "objects",
          ].includes(k),
      ))
  )
    throw new Error("Invalid feature category metadata");
  if (
    manifest.selection?.routingPaddingCells !== undefined &&
    (!Number.isInteger(manifest.selection.routingPaddingCells) ||
      manifest.selection.routingPaddingCells < 0 ||
      manifest.selection.routingPaddingCells > 4)
  )
    throw new Error("Invalid routing selection padding");
  if (manifest.transport) {
    if (
      manifest.transport.version !== 1 ||
      (manifest.transport.graphSnapshot !== undefined &&
        !/^[a-f0-9]{64}$/.test(manifest.transport.graphSnapshot)) ||
      !manifest.transport.profiles ||
      Object.keys(manifest.transport.profiles).length === 0 ||
      Object.keys(manifest.transport.profiles).some(
        (k) => !TRANSPORT_MODES.includes(k as TransportMode),
      )
    )
      throw new Error("Invalid transport metadata");
    for (const mode of TRANSPORT_MODES) {
      const p = manifest.transport.profiles[mode];
      if (!p) continue;
      if (
        p.prefix !== `routing/${mode}/cells` ||
        p.zoom !== 14 ||
        p.codec !== "rcl2" ||
        ![
          p.count,
          p.nodes,
          p.segments,
          p.turns,
          p.skippedWays,
          p.unsupportedRestrictions,
          p.excludedRestrictionWays,
        ].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error("Invalid transport profile");
    }
  }
  if (
    manifest.capabilities.includes("transport-routing") !== !!manifest.transport
  )
    throw new Error("Transport capability mismatch");
  if (manifest.routing) {
    const r = manifest.routing;
    if (
      r.cells &&
      (r.cells.zoom !== 14 ||
        r.cells.codec !== "rcl1" ||
        !Number.isSafeInteger(r.cells.count) ||
        r.cells.count < 1)
    )
      throw new Error("Invalid routing cell metadata");
    if (
      r.profile !== "walking-v1" ||
      r.block !== "routing/walking" ||
      r.scope !== "retained-source-extract" ||
      r.snapLimitMeters !== 150 ||
      ![r.nodes, r.segments, r.bytes, r.skippedWays].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      r.nodes > 8_000_000 ||
      r.segments > 12_000_000 ||
      r.bytes !== 12 + r.nodes * 24 + r.segments * 20 ||
      !blocks.some(
        (b) => b.key === r.block && (b.rawLength ?? b.length) === r.bytes,
      )
    )
      throw new Error("Invalid routing metadata");
  }
  if (manifest.capabilities.includes("walking-routing") && !manifest.routing)
    throw new Error("Missing routing metadata");
  for (const [capability, key] of [
    ["location-search", "search/locations"],
    ["administrative-boundaries", "boundaries/index"],
    ["source-objects", "objects/index"],
    ["reverse-street", "search/streets"],
  ]) {
    if (
      manifest.capabilities.includes(capability!) &&
      !blocks.some((b) => b.key === key)
    )
      throw new Error(`Missing geocoding block: ${key}`);
  }
  validateBlocks(header, manifest, blocks);
  if (header.version === 2) {
    validateBlocks(header, manifest, pages);
    const pageKeys = new Set<string>();
    for (const p of pages) {
      if (
        ![p.z, p.x, p.y, p.count].every(Number.isInteger) ||
        (isTilePrefix(p.prefix ?? "tile")
          ? p.z < manifest.minZoom ||
            p.z > manifest.maxZoom ||
            (p.prefix
              ? !manifest.tileLayers?.includes(p.prefix.slice(5) as MapLayer)
              : !!manifest.tileLayers)
          : p.prefix?.startsWith("raster/")
            ? !manifest.rasters?.some(
                (r) =>
                  p.prefix === `raster/${r.id}` &&
                  p.z >= r.minZoom &&
                  p.z <= r.maxZoom,
              )
            : p.prefix?.startsWith("members/")
              ? p.z !== 26 ||
                !manifest.composition?.members.some(
                  (m) => p.prefix === `members/${m.id}`,
                )
              : isRoutingCell(`${p.prefix}/`)
                ? p.z !== routingZoom(manifest, p.prefix!)
                : p.prefix === "labels/settlements" ||
                    p.prefix === "query/peaks-data"
                  ? p.z !== 8
                  : /^labels\/(roads|pois)\/(13|14|15|16|17)$/.test(p.prefix!)
                    ? p.z !== manifest.labelZoom
                    : /^objects\/(geometry|topology|records|spatial|ids|lookup|tag-values|tag-index|tag-pages)$/.test(
                          p.prefix!,
                        )
                      ? p.z !== 26
                      : /^boundaries\/(records|geometry)$/.test(p.prefix!)
                        ? p.z !== 16
                        : pagedZoom(p.prefix!) !== undefined
                          ? p.z !== pagedZoom(p.prefix!)
                          : !/^features\/(buildings|water|railways|roads|land)$/.test(
                              p.prefix!,
                            ) || p.z !== manifest.featureZoom) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x >= Math.ceil(2 ** p.z / INDEX_PAGE_SIZE) ||
        p.y >= Math.ceil(2 ** p.z / INDEX_PAGE_SIZE) ||
        p.count < 1 ||
        p.count > INDEX_PAGE_SIZE ** 2 ||
        p.rawLength! > MAX_METADATA ||
        p.codec !== "gzip" ||
        p.key !== pageKey(p.prefix ?? "tile", p.z, p.x, p.y) ||
        pageKeys.has(p.key)
      )
        throw new Error("Invalid ATLAS directory page");
      pageKeys.add(p.key);
    }
    if (
      blocks.some(
        (b) =>
          (spatialAddress(b.key) !== null && !/^labels\/\d+\//.test(b.key)) ||
          b.key.startsWith("index/") ||
          b.offset + b.length >
            (pages[0]?.offset ?? header.fileLength - header.payloadOffset),
      )
    )
      throw new Error("Invalid ATLAS root directory");
  }
  const routingCells =
    header.version === 1
      ? blocks.filter((b) => b.key.startsWith("routing/cells/")).length
      : pages
          .filter((p) => p.prefix === "routing/cells")
          .reduce((n, p) => n + p.count, 0);
  if (
    routingCells !== (manifest.routing?.cells?.count ?? 0) ||
    manifest.capabilities.includes("paged-walking-routing") !==
      !!manifest.routing?.cells
  )
    throw new Error("Routing cell directory does not match metadata");
  for (const mode of TRANSPORT_MODES) {
    const prefix = `routing/${mode}/cells`;
    const count =
      header.version === 1
        ? blocks.filter((b) => b.key.startsWith(`${prefix}/`)).length
        : pages
            .filter((p) => p.prefix === prefix)
            .reduce((n, p) => n + p.count, 0);
    if (count !== (manifest.transport?.profiles[mode]?.count ?? 0))
      throw new Error("Transport cell directory mismatch");
  }
  const tileCount =
    header.version === 1
      ? blocks.filter((b) => b.key.startsWith("tile/")).length
      : pages
          .filter((p) => isTilePrefix(p.prefix ?? "tile"))
          .reduce((n, p) => n + p.count, 0);
  return {
    header,
    manifest,
    blocks,
    pages,
    tileCount,
    blockCount: blocks.length + pages.reduce((n, p) => n + p.count, 0),
  };
}
export function validateBlocks(
  header: Header,
  manifest: Manifest,
  blocks: Block[],
) {
  if (!Array.isArray(blocks)) throw new Error("Invalid ATLAS block directory");
  const keys = new Set<string>();
  let end = 0;
  for (const block of blocks) {
    if (
      (block.codec !== undefined && block.codec !== "gzip") ||
      (block.codec === "gzip" &&
        (!Number.isSafeInteger(block.rawLength) ||
          block.rawLength! < 0 ||
          block.rawLength! > 768 * 1024 * 1024)) ||
      (block.codec === undefined && block.rawLength !== undefined) ||
      typeof block.key !== "string" ||
      keys.has(block.key) ||
      !Number.isSafeInteger(block.offset) ||
      !Number.isSafeInteger(block.length) ||
      block.offset < end ||
      block.length < 0 ||
      block.offset + block.length > header.fileLength - header.payloadOffset ||
      !/^[a-f0-9]{64}$/.test(block.hash)
    )
      throw new Error("Invalid ATLAS block directory");
    if (
      block.key.startsWith("labels/") &&
      block.key !== "labels/places" &&
      !block.key.startsWith("labels/settlements/")
    ) {
      const match =
        /^labels\/(\d+)\/(\d+)\/(\d+)(?:\/(roads|pois)\/(13|14|15|16|17))?$/.exec(
          block.key,
        );
      if (
        !match ||
        Number(match[1]) !== manifest.labelZoom ||
        Number(match[2]) >= 2 ** manifest.labelZoom! ||
        Number(match[3]) >= 2 ** manifest.labelZoom!
      )
        throw new Error("Invalid label address");
    }
    if (
      block.key.startsWith("labels/settlements/") ||
      block.key.startsWith("query/peaks-data/")
    ) {
      const a = spatialAddress(block.key);
      if (
        !a ||
        a.z !== 8 ||
        a.x >= 256 ||
        a.y >= 256 ||
        (block.rawLength ?? block.length) > 4 * 1024 * 1024
      )
        throw new Error("Invalid geographic semantic page");
    }
    if (
      block.key.startsWith("boundaries/") &&
      block.key !== "boundaries/index"
    ) {
      const a = spatialAddress(block.key);
      if (
        !a ||
        a.z !== 16 ||
        a.x >= 65536 ||
        a.y >= 65536 ||
        block.key !== `${a.prefix}/16/${a.x}/${a.y}` ||
        (a.prefix === "boundaries/records" &&
          (block.rawLength ?? block.length) > 1024 ** 2)
      )
        throw new Error("Invalid boundary block address or size");
    }
    if (block.key.startsWith("members/")) {
      const a = spatialAddress(block.key),
        member = manifest.composition?.members.find(
          (m) => a?.prefix === `members/${m.id}`,
        );
      if (
        !a ||
        !member ||
        a.z !== 26 ||
        a.y !== 0 ||
        a.x < 0 ||
        a.x >= Math.ceil(member.bytes / MEMBER_CHUNK_BYTES) ||
        block.codec ||
        block.length !==
          Math.min(MEMBER_CHUNK_BYTES, member.bytes - a.x * MEMBER_CHUNK_BYTES)
      )
        throw new Error("Invalid embedded member block");
    }
    if (block.key.startsWith("objects/") && block.key !== "objects/index") {
      const a = spatialAddress(block.key);
      if (
        !a ||
        a.z !== 26 ||
        a.x >= 2 ** 26 ||
        a.y >= 2 ** 26 ||
        (block.rawLength ?? block.length) > 4 * 1024 ** 2
      )
        throw new Error("Invalid source-object block address or size");
    }
    if (block.key.startsWith("features/") && block.key !== "features/geojson") {
      const a = spatialAddress(block.key);
      if (
        !a ||
        a.z !== (pagedZoom(a.prefix) ?? manifest.featureZoom) ||
        ((a.prefix === "features/attributes" ||
          a.prefix === "features/geometry") &&
          (manifest.featureSchema !== 2 ||
            (block.rawLength ?? block.length) > 4 * 1024 ** 2)) ||
        a.x < 0 ||
        a.y < 0 ||
        a.x >= 2 ** a.z ||
        a.y >= 2 ** a.z
      )
        throw new Error("Invalid feature address");
    }
    if (
      block.key.startsWith("search/") &&
      !["search/locations", "search/streets"].includes(block.key)
    ) {
      const a = spatialAddress(block.key);
      if (
        !a ||
        a.z !== pagedZoom(a.prefix) ||
        a.x >= 2 ** a.z ||
        a.y >= 2 ** a.z ||
        block.key !== `${a.prefix}/${a.z}/${a.x}/${a.y}` ||
        (block.rawLength ?? block.length) > 4 * 1024 * 1024
      )
        throw new Error("Invalid search page address or size");
    }
    if (isRoutingCell(block.key)) {
      const a = spatialAddress(block.key);
      if (
        !a ||
        a.z !== routingZoom(manifest, a.prefix) ||
        a.x >= 2 ** a.z ||
        a.y >= 2 ** a.z ||
        block.key !== `${a.prefix}/${a.z}/${a.x}/${a.y}` ||
        (block.rawLength ?? block.length) > 16 * 1024 * 1024
      )
        throw new Error("Invalid routing cell address or size");
    }
    if (block.key.startsWith("raster/")) {
      const a = spatialAddress(block.key),
        r = manifest.rasters?.find((r) => a?.prefix === `raster/${r.id}`);
      if (
        !a ||
        !r ||
        a.z < r.minZoom ||
        a.z > r.maxZoom ||
        a.x >= 2 ** a.z ||
        a.y >= 2 ** a.z ||
        block.key !== `${a.prefix}/${a.z}/${a.x}/${a.y}` ||
        (block.rawLength ?? block.length) > 8 * 1024 ** 2
      )
        throw new Error("Invalid raster tile address or size");
    }
    if (block.key.startsWith("tile/")) {
      if (
        ![block.z, block.x, block.y].every(Number.isInteger) ||
        block.z! < manifest.minZoom ||
        block.z! > manifest.maxZoom ||
        block.x! < 0 ||
        block.y! < 0 ||
        block.x! >= 2 ** block.z! ||
        block.y! >= 2 ** block.z! ||
        (manifest.tileLayers
          ? !tileLayer(block.key) ||
            !manifest.tileLayers.includes(tileLayer(block.key)!) ||
            block.key !==
              `tile/${tileLayer(block.key)}/${block.z}/${block.x}/${block.y}`
          : block.key !== `tile/${block.z}/${block.x}/${block.y}`)
      )
        throw new Error("Invalid tile address");
    }
    keys.add(block.key);
    end = block.offset + block.length;
  }
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function project(lon: number, lat: number): [number, number] {
  const radians =
    (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return [
    (lon + 180) / 360,
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  ];
}
export function unproject(x: number, y: number): [number, number] {
  return [
    x * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  ];
}
