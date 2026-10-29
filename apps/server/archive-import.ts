import { createHash } from "node:crypto";
import { link, open } from "node:fs/promises";
import { AtlasReader } from "../../packages/format/src/reader";
import { importMbtiles } from "../../packages/raster/src/mbtiles";
import type { PreparationProgress } from "../../packages/provisioning/src/selection";

export interface ArchiveImport {
  filename: string;
  size: number;
  format: "atlas" | "mbtiles";
}
/** Verify before publishing; keep Atlas bytes and every embedded capability unchanged. */
export async function importArchive(
  input: string,
  output: string,
  archive: ArchiveImport,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  let phase = "",
    started = performance.now();
  const progress = (
    stage: string,
    message: string,
    completed: number,
    total: number,
    unit: "bytes" | "blocks",
  ) => {
    if (stage !== phase) {
      phase = stage;
      started = performance.now();
    }
    const elapsedSeconds = (performance.now() - started) / 1000;
    report({
      phase:
        stage === "tiles"
          ? "compiling"
          : stage === "payload"
            ? "packing"
            : "verifying",
      stage,
      message,
      completed,
      total,
      unit,
      elapsedSeconds,
      etaSeconds:
        completed > 0
          ? (elapsedSeconds * (total - completed)) / completed
          : undefined,
      readBytes: unit === "bytes" ? completed : 0,
      writtenBytes: 0,
    });
  };
  signal.throwIfAborted();
  progress(
    "opening",
    `Inspecting uploaded ${archive.format.toUpperCase()}…`,
    0,
    0,
    "bytes",
  );
  if (archive.format === "mbtiles") {
    await importMbtiles(
      input,
      output,
      { sourceFilename: archive.filename },
      Number.MAX_SAFE_INTEGER,
      signal,
      (p) =>
        progress(
          p.phase,
          {
            fingerprint: "Fingerprinting source",
            tiles: "Importing raster tiles",
            directory: "Packing tile directory",
            payload: "Writing Atlas archive",
          }[p.phase],
          p.completed,
          p.total,
          p.phase === "tiles" ? "blocks" : "bytes",
        ),
    );
    return;
  }
  const file = await open(input, "r"),
    before = await file.stat({ bigint: true });
  let reader: AtlasReader | undefined;
  try {
    if (Number(before.size) !== archive.size)
      throw new Error("Uploaded file size changed");
    const read = async (start: number, end: number) => {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end > archive.size ||
        end < start
      )
        throw new Error("Archive range exceeds uploaded file");
      const bytes = new Uint8Array(end - start);
      let at = 0;
      while (at < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          at,
          bytes.length - at,
          start + at,
        );
        if (!bytesRead) throw new Error("Truncated archive");
        at += bytesRead;
      }
      return bytes;
    };
    reader = await new AtlasReader({ read }).open();
    let completed = 0;
    const total =
      reader.index.blocks.reduce((n, b) => n + b.length, 0) +
      reader.index.pages.reduce((n, p) => n + p.length, 0);
    // The total payload size includes paged tiles as well as directory pages.
    const payloadBytes = archive.size - reader.index.header.payloadOffset;
    for await (const block of reader.iterateBlocks()) {
      const hash = createHash("sha256"),
        start = reader.index.header.payloadOffset + block.offset;
      for (let at = 0; at < block.length; at += 1024 * 1024) {
        const length = Math.min(1024 * 1024, block.length - at);
        hash.update(await read(start + at, start + at + length));
        completed += length;
        progress(
          "blocks",
          "Verifying Atlas block checksums",
          completed,
          Math.max(total, payloadBytes),
          "bytes",
        );
      }
      if (hash.digest("hex") !== block.hash)
        throw new Error(`Corrupt Atlas block: ${block.key}`);
    }
    const after = await file.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs)
      throw new Error("Uploaded archive changed during verification");
    signal.throwIfAborted();
    // Same volume: atomic publication without making another copy of a large archive.
    await link(input, output);
    progress(
      "published",
      "Atlas verified · registering map",
      archive.size,
      archive.size,
      "bytes",
    );
  } finally {
    reader?.dispose();
    await file.close();
  }
}
