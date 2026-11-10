import { familyCatalog } from "./families";
import {
  HEADER_SIZE,
  MAGIC,
  MAX_METADATA,
  INDEX_PAGE_SIZE,
  spatialAddress,
  pageKey,
  type IndexPage,
  sha256,
  type Manifest,
  type Block,
} from "./index";
export interface InputBlock {
  key: string;
  bytes: Uint8Array;
  features?: number;
  z?: number;
  x?: number;
  y?: number;
  /** Bytes are already compressed. Hashes cover the stored representation. */
  codec?: "gzip";
  rawLength?: number;
}
export async function describeBlock(
  input: InputBlock,
  offset: number,
): Promise<Block> {
  return {
    key: input.key,
    offset,
    length: input.bytes.length,
    hash: await sha256(input.bytes),
    features: input.features ?? 0,
    ...(input.codec ? { codec: input.codec, rawLength: input.rawLength } : {}),
    ...(input.z === undefined ? {} : { z: input.z, x: input.x, y: input.y }),
  };
}
export async function encodePrefix(
  manifest: Omit<Manifest, "snapshot">,
  blocks: Block[],
  payloadLength: number,
  pages?: IndexPage[],
) {
  if (new Set(blocks.map((b) => b.key)).size !== blocks.length)
    throw new Error("Duplicate block");
  // Known descriptors follow the final manifest; optional extension descriptors survive.
  if (manifest.families)
    manifest = { ...manifest, families: familyCatalog(manifest) };
  const encoder = new TextEncoder();
  const snapshot = await sha256(
    encoder.encode(
      JSON.stringify({
        manifest,
        ...(pages ? { pages } : {}),
        blocks: blocks.map(({ key, hash, codec, rawLength }) => ({
          key,
          hash,
          ...(codec ? { codec, rawLength } : {}),
        })),
      }),
    ),
  );
  const metadata = encoder.encode(JSON.stringify({ ...manifest, snapshot }));
  const directory = encoder.encode(
    JSON.stringify(pages ? { blocks, pages } : blocks),
  );
  if (metadata.length + directory.length > MAX_METADATA)
    throw new Error("Prototype metadata limit exceeded");
  const prefix = new Uint8Array(
    HEADER_SIZE + metadata.length + directory.length,
  );
  const view = new DataView(prefix.buffer);
  prefix.set(encoder.encode(MAGIC));
  view.setUint32(8, pages ? 2 : 1, true);
  view.setUint32(12, metadata.length, true);
  view.setUint32(16, directory.length, true);
  view.setUint32(20, prefix.length, true);
  view.setBigUint64(24, BigInt(prefix.length + payloadLength), true);
  prefix.set(metadata, HEADER_SIZE);
  prefix.set(directory, HEADER_SIZE + metadata.length);
  return prefix;
}
export async function encodePackage(
  manifest: Omit<Manifest, "snapshot">,
  inputs: InputBlock[],
  options: { paged?: boolean } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  const blocks: Block[] = [];
  for (const input of inputs) {
    blocks.push(await describeBlock(input, offset));
    offset += input.bytes.length;
  }
  const encoded = options.paged
    ? await encodePagedIndex(manifest, blocks, offset)
    : { prefix: await encodePrefix(manifest, blocks, offset), pages: [] };
  const { prefix, pages } = encoded;
  const output = new Uint8Array(
    prefix.length + offset + pages.reduce((n, p) => n + p.length, 0),
  );
  output.set(prefix);
  inputs.forEach((input, i) =>
    output.set(input.bytes, prefix.length + blocks[i]!.offset),
  );
  let cursor = prefix.length + offset;
  for (const page of pages) {
    output.set(page, cursor);
    cursor += page.length;
  }
  return output;
}

/** Directory leaves follow the data payload; root pointers need no offset fixups. */
export async function encodePagedIndex(
  manifest: Omit<Manifest, "snapshot">,
  blocks: Block[],
  payloadLength: number,
) {
  if (new Set(blocks.map((b) => b.key)).size !== blocks.length)
    throw new Error("Duplicate block");
  const groups = new Map<string, Block[]>();
  const root: Block[] = [];
  for (const b of blocks) {
    const a = spatialAddress(b.key);
    if (!a) {
      root.push(b);
      continue;
    }
    const key = pageKey(
      a.prefix,
      a.z,
      Math.floor(a.x / INDEX_PAGE_SIZE),
      Math.floor(a.y / INDEX_PAGE_SIZE),
    );
    const group = groups.get(key) ?? [];
    group.push(b);
    groups.set(key, group);
  }
  const pages: Uint8Array<ArrayBuffer>[] = [],
    descriptors: IndexPage[] = [];
  let offset = payloadLength;
  for (const [key, entries] of groups) {
    const raw = new TextEncoder().encode(JSON.stringify(entries));
    const bytes = new Uint8Array(
      await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const a = spatialAddress(entries[0]!.key)!;
    const z = a.z,
      x = Math.floor(a.x / INDEX_PAGE_SIZE),
      y = Math.floor(a.y / INDEX_PAGE_SIZE);
    descriptors.push({
      ...(await describeBlock(
        { key, bytes, codec: "gzip", rawLength: raw.length },
        offset,
      )),
      z: z!,
      x: x!,
      y: y!,
      count: entries.length,
      ...(a.prefix === "tile" ? {} : { prefix: a.prefix }),
    });
    pages.push(bytes);
    offset += bytes.length;
  }
  return {
    prefix: await encodePrefix(manifest, root, offset, descriptors),
    pages,
  };
}
