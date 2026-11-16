import { AtlasReader, FileSource } from "../../format/src/reader";
import { StreamWriter } from "../../cli/src/stream-writer";
import { copyArchiveBlocks } from "../../cli/src/archive-copy";
import { boundaryFeature, boundaryRecords, hasBoundaries } from "./index";
import { BorderDisplayWriter } from "./display-build";
import { hasBorderDisplay } from "./display";

/** Add derived display geometry, preserving the exact source and every old block hash. */
export async function addBorderDisplay(
  input: string,
  output: string,
  signal: AbortSignal,
  report: (s: string) => void = () => {},
) {
  if (await Bun.file(output).exists())
    throw new Error("Choose a new output path; Atlas snapshots are immutable");
  const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
  let writer: StreamWriter | undefined,
    display: BorderDisplayWriter | undefined;
  try {
    if (!hasBoundaries(reader))
      throw new Error("This archive has no retained administrative polygons");
    if (hasBorderDisplay(reader))
      throw new Error("This archive already has a border display layer");
    writer = await new StreamWriter(output, Number.MAX_SAFE_INTEGER).open();
    display = new BorderDisplayWriter(writer);
    let count = 0,
      last = 0;
    for await (const record of boundaryRecords(reader, undefined, signal)) {
      signal.throwIfAborted();
      display.add(await boundaryFeature(reader, record));
      reader.cache.delete(record.geometry);
      if (++count % 1000 === 0)
        report(`Generalizing retained administrative polygons · ${count}`);
    }
    await display.finish();
    display = undefined;
    await copyArchiveBlocks(input, writer, signal, (bytes) => {
      if (performance.now() - last > 1000) {
        report(
          `Reusing verified map data · ${(bytes / 1024 ** 3).toFixed(2)} GiB`,
        );
        last = performance.now();
      }
    });
    const { snapshot, ...manifest } = reader.index.manifest;
    const bytes = await writer.finish(
      {
        ...manifest,
        capabilities: [...manifest.capabilities, "boundary-rendering"],
        amendment: {
          version: 1,
          parentSnapshot: snapshot,
          sourceSnapshot: snapshot,
          builder: "atlas-boundary-display-v1",
          addedFamilies: ["boundary-display"],
          routingPaddingCells: 0,
        },
        transport: manifest.transport
          ? {
              ...manifest.transport,
              graphSnapshot: manifest.transport.graphSnapshot ?? snapshot,
            }
          : undefined,
        limitations: [
          ...manifest.limitations.filter(
            (s) => !s.includes("automatic border-line styling is not included"),
          ),
          "Administrative outlines are simplified from the retained source polygons for display. Exact analysis polygons and source identities are unchanged. Shared edges are not jointly simplified; administrative levels differ between countries. Countries appear at z0, levels 3–4 at z3, 5–6 at z5, 7–8 at z8 and finer levels at z10.",
        ],
      },
      undefined,
      (stage, n, total) => {
        signal.throwIfAborted();
        if (performance.now() - last > 1000) {
          report(`${stage} · ${n}/${total}`);
          last = performance.now();
        }
      },
    );
    return { bytes, boundaries: count, parentSnapshot: snapshot };
  } catch (e) {
    await writer?.abort();
    throw e;
  } finally {
    display?.close();
    reader.dispose();
  }
}
