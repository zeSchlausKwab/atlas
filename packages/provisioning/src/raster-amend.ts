import { link, open, rm } from "node:fs/promises";
import { AtlasReader, FileSource } from "../../format/src/reader";
import { sha256, type Manifest, type Block } from "../../format/src/index";
import { familyCatalog } from "../../format/src/families";
import { validateRasters, type RasterLayer } from "../../format/src/raster";
import { StreamWriter } from "../../cli/src/stream-writer";
import { DISK_RESERVE, validBudget } from "./capacity";
import type { PreparationProgress } from "./selection";
/** Complete desired raster set. No source means retain the target's existing layer. */
export interface RasterChoice {
  id: string;
  name: string;
  sourceId?: string;
  sourceSnapshot?: string;
  sourceLayer?: string;
}
export interface RasterAmendment {
  targetId: string;
  targetSnapshot: string;
  name: string;
  layers: RasterChoice[];
  maxBytes: number;
  allowStorageRisk?: boolean;
}
export interface RasterAmendmentPlan {
  request: RasterAmendment;
  reuse: { blocks: number; bytes: number };
  addition: { blocks: number; bytes: number };
  removed: string[];
  replaced: string[];
  layers: RasterLayer[];
  estimatedOutputBytes: number;
  estimatedWorkspaceBytes: number;
  warnings: string[];
}
type Source = { manifest: Manifest; reader: AtlasReader };
type Copy = {
  reader: AtlasReader;
  block: Block;
  key: string;
  imported: boolean;
};
const intersect = (
  a: number[],
  b: number[],
): [number, number, number, number] => [
  Math.max(a[0]!, b[0]!),
  Math.max(a[1]!, b[1]!),
  Math.min(a[2]!, b[2]!),
  Math.min(a[3]!, b[3]!),
];
const overlaps = (a: number[], b: number[]) => {
  const c = intersect(a, b);
  return c[0] < c[2] && c[1] < c[3];
};
function tileBounds(key: string) {
  const parts = key.split("/"),
    z = Number(parts[2]),
    x = Number(parts[3]),
    y = Number(parts[4]),
    n = 2 ** z;
  if (
    parts.length !== 5 ||
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 18 ||
    x < 0 ||
    y < 0 ||
    x >= n ||
    y >= n
  )
    throw new Error(`Invalid raster tile ${key}`);
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}
async function prepare(
  target: AtlasReader,
  sources: Map<string, AtlasReader>,
  request: RasterAmendment,
  signal: AbortSignal,
) {
  const m = target.index.manifest;
  if (!request || request.targetSnapshot !== m.snapshot)
    throw new Error(
      "Target revision changed. Review the imagery amendment again.",
    );
  if (
    typeof request.name !== "string" ||
    !request.name.trim() ||
    request.name.length > 80 ||
    !validBudget(request.maxBytes)
  )
    throw new Error("Invalid revision name or output budget");
  if (!Array.isArray(request.layers) || request.layers.length > 32)
    throw new Error("Choose up to 32 raster layers");
  if (
    request.allowStorageRisk !== undefined &&
    typeof request.allowStorageRisk !== "boolean"
  )
    throw new Error("Invalid storage override");
  const ids = new Set<string>(),
    layers: RasterLayer[] = [],
    imports = new Map<
      string,
      { source: Source; choice: RasterChoice; layer: RasterLayer }
    >(),
    retain = new Set<string>();
  for (const choice of request.layers) {
    signal.throwIfAborted();
    if (
      !choice ||
      typeof choice.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(choice.id) ||
      ids.has(choice.id) ||
      typeof choice.name !== "string" ||
      !choice.name.trim() ||
      choice.name.length > 80
    )
      throw new Error("Layer IDs must be distinct; give each layer a name");
    ids.add(choice.id);
    if (choice.sourceId !== undefined) {
      const reader = sources.get(choice.sourceId),
        source = reader && { reader, manifest: reader.index.manifest };
      if (!source || source.manifest.snapshot !== choice.sourceSnapshot)
        throw new Error("Imagery source revision changed or is unavailable");
      const original = source.manifest.rasters?.find(
        (r) => r.id === choice.sourceLayer,
      );
      if (!original)
        throw new Error("Imagery layer is missing from its source");
      if (!overlaps(original.bounds, m.bounds))
        throw new Error(`${choice.name} does not overlap the target map`);
      const layer: RasterLayer = {
        ...structuredClone(original),
        id: choice.id,
        name: choice.name.trim(),
        bounds: intersect(original.bounds, m.bounds),
        provenance: {
          archiveSnapshot: source.manifest.snapshot,
          layerId: original.id,
        },
      };
      layers.push(layer);
      imports.set(choice.id, { source, choice, layer });
    } else {
      if (
        choice.sourceLayer !== undefined ||
        choice.sourceSnapshot !== undefined
      )
        throw new Error("Retained layers must not specify an import source");
      const original = m.rasters?.find((r) => r.id === choice.id);
      if (!original)
        throw new Error("Choose an installed layer or a pinned import source");
      retain.add(choice.id);
      layers.push({ ...structuredClone(original), name: choice.name.trim() });
    }
  }
  validateRasters(layers);
  if (JSON.stringify(layers) === JSON.stringify(m.rasters ?? []))
    throw new Error("No imagery changes selected");
  // Iterate directory pages twice (plan/copy), keeping memory independent of archive size.
  async function* copies(): AsyncGenerator<Copy> {
    for await (const block of target.iterateBlocks()) {
      signal.throwIfAborted();
      if (
        block.key.startsWith("raster/") &&
        !retain.has(block.key.split("/")[1]!)
      )
        continue;
      yield { reader: target, block, key: block.key, imported: false };
    }
    for (const { source, choice, layer } of imports.values()) {
      let count = 0;
      for await (const block of source.reader.iterateBlocks(
        `raster/${choice.sourceLayer}/`,
      )) {
        signal.throwIfAborted();
        if (!overlaps(tileBounds(block.key), layer.bounds)) continue;
        yield {
          reader: source.reader,
          block,
          key: `raster/${choice.id}/${block.key.split("/").slice(2).join("/")}`,
          imported: true,
        };
        count++;
      }
      if (!count) throw new Error(`No retained tiles intersect ${choice.name}`);
    }
  }
  const reuse = { blocks: 0, bytes: 0 },
    addition = { blocks: 0, bytes: 0 };
  for await (const item of copies()) {
    const tally = item.imported ? addition : reuse;
    tally.blocks++;
    tally.bytes += item.block.length;
  }
  if (!reuse.blocks && !addition.blocks)
    throw new Error("No data would remain in this archive");
  const estimatedOutputBytes =
    reuse.bytes +
    addition.bytes +
    (reuse.blocks + addition.blocks) * 512 +
    65536;
  if (reuse.bytes + addition.bytes > request.maxBytes)
    throw new Error("Amended payload exceeds output budget");
  const plan: RasterAmendmentPlan = {
    request: structuredClone(request),
    reuse,
    addition,
    layers,
    removed: (m.rasters ?? []).filter((r) => !ids.has(r.id)).map((r) => r.id),
    replaced: (m.rasters ?? [])
      .filter((r) => imports.has(r.id))
      .map((r) => r.id),
    estimatedOutputBytes,
    estimatedWorkspaceBytes:
      DISK_RESERVE + estimatedOutputBytes + 64 * 1024 ** 2,
    warnings: [
      "Existing compressed data is copied into a new self-contained file; no PBF or image reprocessing is needed. The old file stays on disk.",
      "Imports retain whole XYZ tiles intersecting the target bounding rectangle. Display is clipped to layer bounds; this is not pixel masking to an arbitrary selection polygon.",
      "Raster layers keep independent source attribution and coverage. Their presence does not extend routing or search coverage.",
      "Cancellation removes the partial revision; requeue repeats copying. Hashtree publication is explicit.",
    ],
  };
  return { plan, copies };
}
export async function planRasterAmendment(
  target: AtlasReader,
  sources: Map<string, AtlasReader>,
  request: RasterAmendment,
  signal = new AbortController().signal,
) {
  return (await prepare(target, sources, request, signal)).plan;
}
export async function amendRasters(
  target: AtlasReader,
  sources: Map<string, AtlasReader>,
  request: RasterAmendment,
  output: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void = () => {},
  checkSpace: () => Promise<void> = async () => {},
) {
  report({
    phase: "planning",
    message: "Checking raster families and coverage…",
    completed: 0,
    total: 0,
    readBytes: 0,
    writtenBytes: 0,
  });
  const { plan, copies } = await prepare(target, sources, request, signal);
  if (await Bun.file(output).exists())
    throw new Error("Output already exists; published archives are immutable");
  const lock = await open(output + ".amend.lock", "wx"),
    staging = output + ".amend.part";
  let writer: StreamWriter | undefined;
  try {
    await checkSpace();
    writer = await new StreamWriter(staging, request.maxBytes).open();
    const total = plan.reuse.bytes + plan.addition.bytes,
      started = performance.now();
    let completed = 0,
      checked = 0;
    for await (const item of copies()) {
      signal.throwIfAborted();
      const { block, reader } = item,
        start = reader.index.header.payloadOffset + block.offset,
        bytes = await reader.source.read(start, start + block.length, signal);
      if (bytes.length !== block.length || (await sha256(bytes)) !== block.hash)
        throw new Error(`Checksum mismatch: ${block.key}`);
      await writer.add({ ...block, key: item.key, bytes }, { compress: false });
      completed += bytes.length;
      if (completed - checked > 32 * 1024 ** 2) {
        await checkSpace();
        checked = completed;
      }
      const elapsedSeconds = (performance.now() - started) / 1000;
      report({
        phase: "packing",
        message: `${item.imported ? "Adding" : "Reusing"} ${item.key}`,
        completed,
        total,
        unit: "bytes",
        readBytes: completed,
        writtenBytes: writer.bytesWritten,
        elapsedSeconds,
        etaSeconds: completed
          ? (elapsedSeconds * (total - completed)) / completed
          : undefined,
      });
    }
    const { snapshot, ...base } = target.index.manifest;
    const manifest: Omit<Manifest, "snapshot"> = {
      ...base,
      name: request.name.trim(),
      rasters: plan.layers,
      capabilities: [
        ...base.capabilities.filter((c) => c !== "raster-rendering"),
        ...(plan.layers.length ? ["raster-rendering"] : []),
      ],
      transport: base.transport
        ? {
            ...base.transport,
            graphSnapshot: base.transport.graphSnapshot ?? snapshot,
          }
        : undefined,
      amendment: {
        version: 1,
        parentSnapshot: snapshot,
        sourceSnapshot: snapshot,
        builder: "atlas-raster-amendment-v1",
        addedFamilies: plan.layers.length
          ? plan.layers.map((r) => `raster:${r.id}`)
          : ["raster-removal"],
        routingPaddingCells: base.selection?.routingPaddingCells ?? 0,
      },
    };
    manifest.families = familyCatalog(manifest);
    signal.throwIfAborted();
    await checkSpace();
    const size = await writer.finish(
      manifest,
      undefined,
      (stage, completed, total) => {
        signal.throwIfAborted();
        report({
          phase: "indexing",
          message: `Finalizing ${stage}`,
          completed,
          total,
          readBytes: plan.reuse.bytes + plan.addition.bytes,
          writtenBytes: writer!.bytesWritten,
        });
      },
    );
    const verified = await new AtlasReader(
      new FileSource(Bun.file(staging)),
    ).open();
    const result = { size, manifest: verified.index.manifest, plan };
    verified.dispose();
    signal.throwIfAborted();
    await link(staging, output);
    return result;
  } catch (e) {
    await writer?.abort();
    throw e;
  } finally {
    await rm(staging, { force: true });
    await lock.close();
    await rm(output + ".amend.lock", { force: true });
  }
}
