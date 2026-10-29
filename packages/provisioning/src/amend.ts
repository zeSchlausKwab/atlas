import difference from "@turf/difference";
import type { Feature, Polygon } from "geojson";
import { link, open, rm } from "node:fs/promises";
import { StreamWriter } from "../../cli/src/stream-writer";
import { AtlasReader, FileSource } from "../../format/src/reader";
import {
  sha256,
  TRANSPORT_MODES,
  type Manifest,
  type TransportMode,
  type Block,
} from "../../format/src/index";
import {
  planPreparation,
  type PackageSelection,
  type PreparationProgress,
} from "./selection";
import { validBudget, DISK_RESERVE } from "./capacity";

export interface RoutingAmendment {
  targetSnapshot: string;
  sourceSnapshot: string;
  name: string;
  profiles: TransportMode[];
  paddingCells: number;
  maxBytes: number;
}
export interface AmendmentPlan {
  version: 1;
  kind: "routing";
  targetSnapshot: string;
  sourceSnapshot: string;
  graphSnapshot: string;
  profiles: TransportMode[];
  reuse: { blocks: number; bytes: number };
  addition: {
    blocks: number;
    bytes: number;
    cells: Partial<Record<TransportMode, number>>;
  };
  estimatedOutputBytes: number;
  estimatedWorkspaceBytes: number;
  warnings: string[];
}
const polygon = (m: Manifest): [number, number][] =>
  m.selection?.polygon ?? [
    [m.bounds[0], m.bounds[1]],
    [m.bounds[2], m.bounds[1]],
    [m.bounds[2], m.bounds[3]],
    [m.bounds[0], m.bounds[3]],
  ];
function region(m: Manifest): Feature<Polygon> {
  const p = polygon(m);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[...p, p[0]!]] },
  };
}
/** Metadata-only compatibility check. Both UI planning and the worker repeat it. */
export function routingAmendmentSelection(
  target: Manifest,
  source: Manifest,
  value: unknown,
): PackageSelection {
  const a = value as RoutingAmendment;
  if (
    !a ||
    a.targetSnapshot !== target.snapshot ||
    a.sourceSnapshot !== source.snapshot
  )
    throw new Error("Amendment snapshot changed. Review the plan again.");
  if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 80)
    throw new Error("Give the new revision a name of 1–80 characters.");
  if (!validBudget(a.maxBytes))
    throw new Error("Choose a valid output size budget.");
  if (
    !Number.isInteger(a.paddingCells) ||
    a.paddingCells < 0 ||
    a.paddingCells > 4
  )
    throw new Error("Routing padding must be 0–4 cells.");
  if (
    !Array.isArray(a.profiles) ||
    !a.profiles.length ||
    new Set(a.profiles).size !== a.profiles.length ||
    a.profiles.some((p) => !TRANSPORT_MODES.includes(p))
  )
    throw new Error("Choose one or more distinct transport profiles.");
  if (!target.source.sha256 || target.source.sha256 !== source.source.sha256)
    throw new Error(
      "Routing must come from the exact same source PBF snapshot.",
    );
  if (target.routing)
    throw new Error(
      "This revision has legacy routing. Migrating an existing legacy graph is not supported by this additive amendment.",
    );
  const graph = source.transport?.graphSnapshot ?? source.snapshot;
  if (
    target.transport &&
    (target.transport.graphSnapshot ?? target.snapshot) !== graph
  )
    throw new Error(
      "The existing and added profiles must share the same compiled graph identity.",
    );
  for (const p of a.profiles) {
    if (target.transport?.profiles[p])
      throw new Error(
        `${p} routing already exists; this amendment only adds missing profiles.`,
      );
    if (!source.transport?.profiles[p])
      throw new Error(
        `Source has no ${p} routing cells. A routing construction pass is required.`,
      );
  }
  if (
    difference({
      type: "FeatureCollection",
      features: [region(target), region(source)],
    })
  )
    throw new Error("Routing source must cover the entire target polygon.");
  return {
    snapshot: source.snapshot,
    name: a.name.trim(),
    polygon: polygon(target),
    minZoom: source.minZoom,
    maxZoom: source.minZoom,
    layers: [],
    placeNames: false,
    streetNames: false,
    pois: false,
    profiles: [...a.profiles],
    search: false,
    reverse: false,
    peaks: false,
    featureKinds: [],
    paddingCells: a.paddingCells,
    maxBytes: a.maxBytes,
  };
}
async function preparePlan(
  target: AtlasReader,
  source: AtlasReader,
  options: RoutingAmendment,
  signal: AbortSignal,
  report: (message: string) => void,
) {
  const selection = routingAmendmentSelection(
    target.index.manifest,
    source.index.manifest,
    options,
  );
  const selected = await planPreparation(source, selection, signal, report);
  const cells: AmendmentPlan["addition"]["cells"] = {};
  for (const mode of options.profiles) {
    cells[mode] = selected.blocks.filter((b) =>
      b.key.startsWith(`routing/${mode}/cells/`),
    ).length;
    if (!cells[mode])
      throw new Error(
        `No ${mode} routing cells intersect this map; no amendment was written.`,
      );
  }
  const index = target.index;
  const payloadBytes =
    index.header.fileLength -
    index.header.payloadOffset -
    index.pages.reduce((n, p) => n + p.length, 0);
  // Directory overhead is estimated, not reserved. The writer enforces maxBytes exactly.
  const estimate =
    index.header.fileLength +
    selected.sourceBytes +
    selected.blocks.length * 512 +
    65536;
  if (
    !Number.isSafeInteger(estimate) ||
    payloadBytes + selected.sourceBytes > options.maxBytes
  )
    throw new Error(
      "The existing data plus added routing exceeds the output budget.",
    );
  const plan: AmendmentPlan = {
    version: 1,
    kind: "routing",
    targetSnapshot: options.targetSnapshot,
    sourceSnapshot: options.sourceSnapshot,
    graphSnapshot:
      source.index.manifest.transport!.graphSnapshot ??
      source.index.manifest.snapshot,
    profiles: [...options.profiles],
    reuse: { blocks: index.blockCount, bytes: payloadBytes },
    addition: {
      blocks: selected.blocks.length,
      bytes: selected.sourceBytes,
      cells,
    },
    estimatedOutputBytes: estimate,
    estimatedWorkspaceBytes:
      Math.min(options.maxBytes, estimate) + 64 * 1024 ** 2 + DISK_RESERVE,
    warnings: [
      "The original file stays available. This version copies its compressed blocks into a new self-contained file; it does not append in place.",
      "Routing includes whole intersecting cells with requested padding where the source has data. Paths leaving retained coverage report missing cells.",
      "Cancellation removes partial output; requeue repeats the copy. Output and workspace sizes are estimates; the output budget is enforced during writing.",
      "Publishing this revision creates a new archive hash and Hashtree root. Cross-revision Hashtree leaf reuse is not guaranteed.",
    ],
  };
  return { plan, blocks: selected.blocks };
}
export async function planRoutingAmendment(
  target: AtlasReader,
  source: AtlasReader,
  options: RoutingAmendment,
  signal = new AbortController().signal,
  report = (_: string) => {},
) {
  return (await preparePlan(target, source, options, signal, report)).plan;
}
/** Copy verified compressed blocks; build only the new directory/manifest. */
export async function amendRouting(
  target: AtlasReader,
  source: AtlasReader,
  options: RoutingAmendment,
  output: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void = () => {},
  checkSpace: () => Promise<void> = async () => {},
) {
  const p: PreparationProgress = {
    phase: "planning",
    completed: 0,
    total: 0,
    readBytes: 0,
    writtenBytes: 0,
    message: "Checking amendment dependencies…",
  };
  report({ ...p });
  const { plan, blocks } = await preparePlan(
    target,
    source,
    options,
    signal,
    (message) => report({ ...p, message }),
  );
  signal.throwIfAborted();
  if (await Bun.file(output).exists())
    throw new Error(
      "Choose a new output path; published archives are immutable.",
    );
  const lockPath = output + ".amend.lock";
  const lock = await open(lockPath, "wx");
  const staging = output + ".amend.part";
  let writer: StreamWriter | undefined;
  try {
    if (await Bun.file(output).exists())
      throw new Error("Output already exists.");
    await checkSpace();
    writer = await new StreamWriter(staging, options.maxBytes).open();
    p.phase = "packing";
    p.unit = "bytes";
    p.total = plan.reuse.bytes + plan.addition.bytes;
    const started = performance.now();
    const profiles = structuredClone(
      target.index.manifest.transport?.profiles ?? {},
    );
    for (const mode of options.profiles)
      profiles[mode] = {
        ...source.index.manifest.transport!.profiles[mode]!,
        count: 0,
        nodes: 0,
        segments: 0,
        turns: 0,
      };
    let last = 0,
      lastSpace = 0;
    const copy = async (
      reader: AtlasReader,
      b: Block,
      mode?: TransportMode,
    ) => {
      signal.throwIfAborted();
      if (performance.now() - lastSpace > 1000) {
        await checkSpace();
        lastSpace = performance.now();
      }
      const start = reader.index.header.payloadOffset + b.offset;
      const bytes = await reader.source.read(start, start + b.length, signal);
      if (bytes.length !== b.length || (await sha256(bytes)) !== b.hash)
        throw new Error(`Amendment source checksum mismatch: ${b.key}`);
      if (mode) {
        const raw =
          b.codec === "gzip"
            ? Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>)
            : bytes;
        if (
          raw.length < 36 ||
          new TextDecoder().decode(raw.subarray(0, 4)) !== "RCL2"
        )
          throw new Error(`Invalid routing cell ${b.key}`);
        const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
          profile = profiles[mode]!;
        profile.count++;
        profile.nodes += v.getUint32(20, true);
        profile.segments += v.getUint32(24, true);
        profile.turns += v.getUint32(28, true);
      }
      await writer!.add({ ...b, bytes }, { compress: false });
      p.completed += bytes.length;
      p.readBytes += bytes.length;
      p.writtenBytes = writer!.bytesWritten;
      p.elapsedSeconds = (performance.now() - started) / 1000;
      p.etaSeconds = p.completed
        ? (p.elapsedSeconds * (p.total - p.completed)) / p.completed
        : undefined;
      p.message = `${mode ? "Adding" : "Reusing"} ${b.key}`;
      if (performance.now() - last > 150 || p.completed === p.total) {
        report({ ...p });
        last = performance.now();
      }
    };
    for await (const b of target.iterateBlocks()) await copy(target, b);
    for (const b of blocks) {
      const mode = options.profiles.find((mode) =>
        b.key.startsWith(`routing/${mode}/cells/`),
      );
      if (!mode) throw new Error(`Unexpected amendment block ${b.key}`);
      await copy(source, b, mode);
    }
    const { snapshot, ...m } = target.index.manifest;
    const manifest: Omit<Manifest, "snapshot"> = {
      ...m,
      name: options.name.trim(),
      transport: {
        version: 1,
        graphSnapshot: plan.graphSnapshot,
        statistics: "cell-records",
        profiles,
      },
      capabilities: [...new Set([...m.capabilities, "transport-routing"])],
      amendment: {
        version: 1,
        parentSnapshot: snapshot,
        sourceSnapshot: options.sourceSnapshot,
        builder: "atlas-routing-amendment-v1",
        addedFamilies: options.profiles.map((p) => `routing/${p}`),
        routingPaddingCells: options.paddingCells,
      },
      limitations: [
        ...new Set([
          ...m.limitations,
          ...source.index.manifest.limitations,
          "Routing amendment: copied whole graph cells; graph counts sum cell records. Routes leaving retained coverage require additional compatible data.",
        ]),
      ],
    };
    signal.throwIfAborted();
    await checkSpace();
    const size = await writer.finish(
      manifest,
      undefined,
      (stage, completed, total) => {
        signal.throwIfAborted();
        report({
          ...p,
          phase: "indexing",
          unit: stage === "directory" ? "blocks" : "bytes",
          completed,
          total,
          etaSeconds: undefined,
          message:
            stage === "directory"
              ? "Writing the amended directory…"
              : "Finalizing the new file…",
        });
      },
    );
    const verified = await new AtlasReader(
      new FileSource(Bun.file(staging)),
    ).open();
    const result = { size, manifest: verified.index.manifest, plan };
    verified.dispose();
    report({
      ...p,
      phase: "verifying",
      message: "Verified the new revision. Original archive unchanged.",
      writtenBytes: size,
      completed: 1,
      total: 1,
      unit: "stages",
      etaSeconds: 0,
    });
    signal.throwIfAborted();
    // Same-volume atomic publication: EEXIST never overwrites another writer.
    await link(staging, output);
    return result;
  } catch (error) {
    await writer?.abort();
    throw error;
  } finally {
    await rm(staging, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
