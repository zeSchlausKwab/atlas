/** ATLAS v0.1: immutable single-file package with independently addressed blocks. */
export const MAGIC = "ATLAS001";
export const HEADER_SIZE = 32;
export const TILE_EXTENT = 65535;
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
export interface RoutingMetadata {
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
  labelZoom?: number;
  areas?: { assembledRelations: number; skippedRelations: number };
  featureCountKind?: "tile-records";
  selection?: {
    polygon: [number, number][];
    parentSnapshot: string;
    boundaryPolicy: string;
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
export interface IndexPage extends Block {
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
  if (manifest.capabilities.includes("map-labels") && manifest.labelZoom !== 12)
    throw new Error("Invalid label grid");
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
  if (manifest.routing) {
    const r = manifest.routing;
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
        p.z < manifest.minZoom ||
        p.z > manifest.maxZoom ||
        p.x < 0 ||
        p.y < 0 ||
        p.x >= Math.ceil(2 ** p.z / INDEX_PAGE_SIZE) ||
        p.y >= Math.ceil(2 ** p.z / INDEX_PAGE_SIZE) ||
        p.count < 1 ||
        p.count > INDEX_PAGE_SIZE ** 2 ||
        p.rawLength! > MAX_METADATA ||
        p.codec !== "gzip" ||
        p.key !== `index/tiles/${p.z}/${p.x}/${p.y}` ||
        pageKeys.has(p.key)
      )
        throw new Error("Invalid ATLAS directory page");
      pageKeys.add(p.key);
    }
    if (
      blocks.some(
        (b) =>
          b.key.startsWith("tile/") ||
          b.key.startsWith("index/") ||
          b.offset + b.length >
            (pages[0]?.offset ?? header.fileLength - header.payloadOffset),
      )
    )
      throw new Error("Invalid ATLAS root directory");
  }
  const tileCount =
    header.version === 1
      ? blocks.filter((b) => b.key.startsWith("tile/")).length
      : pages.reduce((n, p) => n + p.count, 0);
  return {
    header,
    manifest,
    blocks,
    pages,
    tileCount,
    blockCount: blocks.length + (header.version === 2 ? tileCount : 0),
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
    if (block.key.startsWith("labels/")) {
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
    if (block.key.startsWith("tile/")) {
      if (
        ![block.z, block.x, block.y].every(Number.isInteger) ||
        block.z! < manifest.minZoom ||
        block.z! > manifest.maxZoom ||
        block.x! < 0 ||
        block.y! < 0 ||
        block.x! >= 2 ** block.z! ||
        block.y! >= 2 ** block.z! ||
        block.key !== `tile/${block.z}/${block.x}/${block.y}`
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
