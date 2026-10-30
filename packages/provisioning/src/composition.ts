import { link, rm } from "node:fs/promises";
import { AtlasReader } from "../../format/src/reader";
import {
  MEMBER_CHUNK_BYTES,
  memberKey,
  type ArchiveComposition,
} from "../../format/src/composition";
import { sha256, type Manifest } from "../../format/src/index";
import { StreamWriter } from "../../cli/src/stream-writer";
import type { PreparationProgress } from "./selection";
/** Pack self-contained members without flattening IDs, search indexes or graph identities. */
export async function packComposition(
  readers: AtlasReader[],
  name: string,
  output: string,
  maxBytes: number,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  if (
    !readers.length ||
    readers.length > 64 ||
    !name.trim() ||
    name.length > 80 ||
    readers.some((r) => r.index.manifest.composition)
  )
    throw new Error("Choose 1–64 ordinary Atlas archives and a name");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Invalid composition output budget");
  signal.throwIfAborted();
  const composition: ArchiveComposition = {
    version: 1,
    members: readers.map((r, i) => ({
      id: `m${i}`,
      snapshot: r.index.manifest.snapshot,
      bytes: r.index.header.fileLength,
    })),
  };
  const total = composition.members.reduce((n, m) => n + m.bytes, 0);
  if (total > maxBytes) throw new Error("Composition exceeds output budget");
  if (await Bun.file(output).exists())
    throw new Error("Output already exists; choose a new revision");
  const staged = `${output}.composition`;
  const writer = await new StreamWriter(staged, maxBytes).open();
  let completed = 0;
  const start = performance.now();
  try {
    for (let i = 0; i < readers.length; i++) {
      const reader = readers[i]!,
        member = composition.members[i]!;
      report({
        phase: "verifying",
        message: `Verifying ${reader.index.manifest.name}`,
        completed: i,
        total: readers.length,
        unit: "stages",
        readBytes: completed,
        writtenBytes: writer.bytesWritten,
      });
      // Validate every retained stored block, including optional custom data, before packaging.
      for await (const block of reader.iterateBlocks()) {
        signal.throwIfAborted();
        const at = reader.index.header.payloadOffset + block.offset;
        if (
          (await sha256(
            await reader.source.read(at, at + block.length, signal),
          )) !== block.hash
        )
          throw new Error(`Checksum mismatch: ${block.key}`);
      }
      for (let at = 0; at < member.bytes; at += MEMBER_CHUNK_BYTES) {
        signal.throwIfAborted();
        const bytes = await reader.source.read(
          at,
          Math.min(at + MEMBER_CHUNK_BYTES, member.bytes),
          signal,
        );
        await writer.add(
          { key: memberKey(member.id, at / MEMBER_CHUNK_BYTES), bytes },
          { compress: false },
        );
        completed += bytes.length;
        const elapsedSeconds = (performance.now() - start) / 1000;
        report({
          phase: "packing",
          message: `Packing ${reader.index.manifest.name}`,
          completed,
          total,
          unit: "bytes",
          readBytes: completed,
          writtenBytes: writer.bytesWritten,
          elapsedSeconds,
          etaSeconds: (elapsedSeconds * (total - completed)) / completed,
        });
      }
    }
    const manifests = readers.map((r) => r.index.manifest);
    const manifest: Omit<Manifest, "snapshot"> = {
      format: "atlas",
      version: 1,
      name: name.trim(),
      composition,
      source: {
        url: "atlas:composition",
        sha256: await sha256(
          new TextEncoder().encode(JSON.stringify(composition)),
        ),
        attribution: [
          ...new Set(manifests.map((m) => m.source.attribution)),
        ].join(" · "),
      },
      bounds: [
        Math.min(...manifests.map((m) => m.bounds[0])),
        Math.min(...manifests.map((m) => m.bounds[1])),
        Math.max(...manifests.map((m) => m.bounds[2])),
        Math.max(...manifests.map((m) => m.bounds[3])),
      ],
      minZoom: Math.min(...manifests.map((m) => m.minZoom)),
      maxZoom: Math.max(...manifests.map((m) => m.maxZoom)),
      features: 0,
      peaks: 0,
      places: [],
      tileLayers: [],
      capabilities: ["map-composition"],
      limitations: [
        "Contains independent Atlas members. Tools use member capabilities; routing requires a compatible OSM source revision and contract, or a shared legacy graph. Custom families retain their original scope and dependencies.",
      ],
    };
    const size = await writer.finish(
      manifest,
      async () => signal.throwIfAborted(),
      (stage, completed, total) => {
        signal.throwIfAborted();
        report({
          phase: "indexing",
          message:
            stage === "directory"
              ? "Writing composition directory"
              : "Finalizing composition payload",
          completed,
          total,
          unit: stage === "directory" ? "blocks" : "bytes",
          readBytes: completed,
          writtenBytes: writer.bytesWritten,
        });
      },
    );
    signal.throwIfAborted();
    await link(staged, output); // Exclusive publication; never replace an existing revision.
    return { size, manifest };
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    await rm(staged, { force: true });
  }
}
