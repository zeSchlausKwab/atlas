import { sameRoutingFederation } from "../../format/src/routing-contract";
import { link, open, rm } from "node:fs/promises";
import { AtlasReader, FileSource } from "../../format/src/reader";
import { sha256, type Manifest, type Block } from "../../format/src/index";
import { StreamWriter } from "../../cli/src/stream-writer";
import { blockFamily, installedCapabilities } from "./families";
import type { PreparationProgress } from "./selection";
export interface CapabilityChange {
  /** Consent for the host planning estimate, never disables runtime disk guards. */
  allowStorageRisk?: boolean;
  targetId: string;
  targetSnapshot: string;
  name: string;
  capabilities: string[];
  maxBytes: number;
  paddingCells: number;
  sourceId?: string;
  sourceKind?: "pbf" | "atlas" | "download";
  sourceSnapshot?: string;
}
/** Family-granular replacement. Unchanged compressed blocks (including unknown ones) are copied verbatim. */
export async function composeCapabilities(
  target: AtlasReader,
  addition: AtlasReader | undefined,
  request: CapabilityChange,
  rebuilt: string[],
  output: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void = () => {},
  checkSpace: () => Promise<void> = async () => {},
) {
  signal.throwIfAborted();
  if (target.index.manifest.snapshot !== request.targetSnapshot)
    throw new Error("Target snapshot changed");
  if (await Bun.file(output).exists())
    throw new Error("Output already exists; revisions are immutable");
  const lock = await open(output + ".amend.lock", "wx"),
    staging = output + ".amend.part";
  let writer: StreamWriter | undefined;
  try {
    writer = await new StreamWriter(staging, request.maxBytes).open();
    await checkSpace();
    let copiedSinceSpaceCheck = 0;
    let completed = 0,
      readBytes = 0,
      last = 0;
    const total = target.index.blockCount + (addition?.index.blockCount ?? 0);
    const copy = async (reader: AtlasReader, b: Block) => {
      signal.throwIfAborted();
      const start = reader.index.header.payloadOffset + b.offset;
      const bytes = await reader.source.read(start, start + b.length, signal);
      if (bytes.length !== b.length || (await sha256(bytes)) !== b.hash)
        throw new Error(`Checksum mismatch: ${b.key}`);
      await writer!.add({ ...b, bytes }, { compress: false });
      readBytes += bytes.length;
      copiedSinceSpaceCheck += bytes.length;
      if (copiedSinceSpaceCheck >= 32 * 1024 ** 2) {
        await checkSpace();
        copiedSinceSpaceCheck = 0;
      }
    };
    for (const [reader, isNew] of [
      [target, false],
      [addition, true],
    ] as const) {
      if (!reader) continue;
      for await (const b of reader.iterateBlocks()) {
        signal.throwIfAborted();
        const family = blockFamily(b.key);
        if (
          isNew
            ? family && rebuilt.includes(family)
            : !family ||
              (request.capabilities.includes(family) &&
                !rebuilt.includes(family))
        )
          await copy(reader, b);
        completed++;
        if (performance.now() - last > 150 || completed === total) {
          last = performance.now();
          report({
            phase: "packing",
            message: `${isNew ? "Adding" : "Reusing"} ${b.key}`,
            completed,
            total,
            unit: "blocks",
            readBytes,
            writtenBytes: writer.bytesWritten,
          });
        }
      }
    }
    const m = target.index.manifest,
      n = addition?.index.manifest;
    const present = request.capabilities.filter((f) =>
      writer!.hasPrefix(
        f.startsWith("raster:")
          ? `raster/${f.slice(7)}/`
          : f.startsWith("tile:")
            ? `tile/${f.slice(5)}/`
            : f.startsWith("routing:")
              ? `routing/${f.slice(8)}/`
              : f === "search"
                ? "search/locations"
                : f === "reverse"
                  ? "search/streets"
                  : f === "peaks"
                    ? "query/peaks"
                    : `${f}/`,
      ),
    );
    const has = (f: string) => present.includes(f),
      owner = (f: string) => (rebuilt.includes(f) ? n! : m);
    const featureKinds = [
      ...(has("features")
        ? (owner("features").featureKinds ?? []).filter(
            (k) => k !== "objects" && k !== "boundaries",
          )
        : []),
      ...(has("boundaries") ? ["boundaries" as const] : []),
      ...(has("objects") ? ["objects" as const] : []),
    ];
    const profiles = Object.fromEntries(
      present
        .filter((f) => f.startsWith("routing:"))
        .map((f) => [
          f.slice(8),
          owner(f).transport!.profiles[f.slice(8) as "walking"],
        ]),
    );
    const routingOwner = present.find((f) => f.startsWith("routing:"));
    if (routingOwner) {
      const base = owner(routingOwner);
      for (const family of present.filter((f) => f.startsWith("routing:"))) {
        const other = owner(family);
        if (
          !sameRoutingFederation(
            base.transport!.federation,
            other.transport!.federation,
          ) ||
          (!base.transport!.federation &&
            (base.transport!.graphSnapshot ?? base.snapshot) !==
              (other.transport!.graphSnapshot ?? other.snapshot))
        )
          throw new Error(
            "Routing profiles must share an identity contract and complete coverage. Rebuild them together to change authority.",
          );
      }
    }
    const known = new Set([
      "vector-rendering",
      "raster-rendering",
      "building-heights",
      "map-labels",
      "location-search",
      "address-search",
      "semantic-locations",
      "reverse-street",
      "peak-query",
      "feature-extraction",
      "source-objects",
      "administrative-boundaries",
      "transport-routing",
      "walking-routing",
      "paged-walking-routing",
      "source-feature-export",
      "land-sea-surfaces",
    ]);
    const caps = [
      ...m.capabilities.filter((c) => !known.has(c)),
      ...(present.some((f) => f.startsWith("raster:"))
        ? ["raster-rendering"]
        : []),
      ...(present.some((f) => f.startsWith("tile:"))
        ? ["vector-rendering"]
        : []),
      ...(has("tile:buildings") && owner("tile:buildings").buildingHeights
        ? ["building-heights"]
        : []),
      ...(has("labels") ? ["map-labels"] : []),
      ...(has("search")
        ? owner("search").capabilities.filter((c) =>
            [
              "location-search",
              "address-search",
              "semantic-locations",
            ].includes(c),
          )
        : []),
      ...(has("reverse") ? ["reverse-street"] : []),
      ...(has("peaks") ? ["peak-query"] : []),
      ...(featureKinds.length ? ["feature-extraction"] : []),
      ...(has("objects") ? ["source-objects"] : []),
      ...(has("boundaries") ? ["administrative-boundaries"] : []),
      ...(routingOwner ? ["transport-routing"] : []),
      ...((has("objects") &&
        owner("objects").capabilities.includes("land-sea-surfaces")) ||
      (has("tile:water") &&
        owner("tile:water").capabilities.includes("land-sea-surfaces"))
        ? ["land-sea-surfaces"]
        : []),
    ];
    const { snapshot, ...base } = m;
    const manifest: Omit<Manifest, "snapshot"> = {
      ...base,
      name: request.name,
      rasters: m.rasters?.filter((r) => has(`raster:${r.id}`)),
      tileLayers: m.tileLayers?.filter((l) => has(`tile:${l}`)) ?? [],
      features: writer.featureCount("tile/"),
      featureCountKind: "tile-records",
      capabilities: [...new Set(caps)],
      featureKinds,
      featureSchema: featureKinds.length ? 2 : undefined,
      featureZoom: featureKinds.length
        ? (n?.featureZoom ?? m.featureZoom)
        : undefined,
      places: has("labels") ? owner("labels").places : [],
      labelZoom: has("labels") ? owner("labels").labelZoom : undefined,
      peaks: has("peaks") ? owner("peaks").peaks : 0,
      semantics: has("search") ? owner("search").semantics : undefined,
      buildingHeights: has("tile:buildings")
        ? owner("tile:buildings").buildingHeights
        : undefined,
      routing: undefined,
      transport: routingOwner
        ? {
            ...owner(routingOwner).transport!,
            profiles,
            graphSnapshot:
              owner(routingOwner).transport!.graphSnapshot ??
              owner(routingOwner).snapshot,
          }
        : undefined,
      amendment: {
        version: 1,
        parentSnapshot: snapshot,
        sourceSnapshot: n?.snapshot ?? snapshot,
        builder: "atlas-capability-composer-v1",
        addedFamilies: rebuilt.length ? rebuilt : ["selection-only"],
        routingPaddingCells: request.paddingCells,
      },
      limitations: [...new Set([...m.limitations, ...(n?.limitations ?? [])])],
    };
    manifest.tileLayers = present
      .filter((f) => f.startsWith("tile:"))
      .map((f) => f.slice(5) as any);
    if (manifest.selection)
      manifest.selection = {
        ...manifest.selection,
        ...(routingOwner ? { routingPaddingCells: request.paddingCells } : {}),
      };
    if (!writer.blockCount)
      throw new Error("No data remains in the selected capabilities");
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
          readBytes,
          writtenBytes: writer!.bytesWritten,
        });
      },
    );
    const verified = await new AtlasReader(
      new FileSource(Bun.file(staging)),
    ).open();
    const result = {
      size,
      manifest: verified.index.manifest,
      emptyFamilies: request.capabilities.filter(
        (f) => !installedCapabilities(verified.index.manifest).includes(f),
      ),
    };
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
