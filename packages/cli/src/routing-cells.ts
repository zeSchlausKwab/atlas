import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AtlasReader, FileSource } from "../../format/src/reader";
import { sha256, type RoutingMetadata } from "../../format/src/index";
import { DiskWriter } from "./disk-writer";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export async function addRoutingCells(
  writer: DiskWriter,
  bytes: Uint8Array,
  prefix = "routing/cells",
): Promise<RoutingMetadata["cells"]> {
  const temp = await mkdtemp(join(tmpdir(), "atlas-routing-input-"));
  try {
    const source = join(temp, "graph.rte");
    await Bun.write(source, bytes);
    return await addRoutingCellFile(writer, source, prefix);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
/** The native compiler already wrote the graph. Partition it in place instead
 * of reading a GiB-sized graph into JS and writing a duplicate scratch file. */
export async function addRoutingCellFile(
  writer: DiskWriter,
  source: string,
  prefix = "routing/cells",
): Promise<RoutingMetadata["cells"]> {
  const temp = await mkdtemp(join(tmpdir(), "atlas-routing-"));
  try {
    const out = join(temp, "cells");
    const build = Bun.spawn(
      [
        "cargo",
        "build",
        "--release",
        "-p",
        "atlas-routing",
        "--bin",
        "partition-routing",
      ],
      { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if (await build.exited) throw new Error("Routing partitioner build failed");
    const process = Bun.spawn(
      [join(ROOT, "target/release/partition-routing"), source, out],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (await process.exited) throw new Error("Routing partition failed");
    const files = (await readdir(out)).sort();
    for (const file of files) {
      const [x, y] = file.replace(".rcl", "").split("-").map(Number);
      const data = new Uint8Array(
        await Bun.file(join(out, file)).arrayBuffer(),
      );
      await writer.add({
        key: `${prefix}/14/${x}/${y}`,
        bytes: data,
        features: new DataView(data.buffer).getUint32(24, true),
      });
    }
    return files.length
      ? { zoom: 14, count: files.length, codec: "rcl1" }
      : undefined;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function partitionPackageRouting(
  input: string,
  output: string,
  maxBytes: number,
  progress = console.log,
) {
  const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
  const routing = reader.index.manifest.routing;
  if (!routing) throw new Error("Package has no reference walking graph");
  if (routing.cells) throw new Error("Package already contains routing cells");
  const writer = await new DiskWriter(output, maxBytes).open();
  let n = 0;
  for (const b of await reader.allBlocks()) {
    const start = reader.index.header.payloadOffset + b.offset;
    const bytes = await reader.source.read(start, start + b.length);
    if ((await sha256(bytes)) !== b.hash)
      throw new Error(`Integrity check failed: ${b.key}`);
    await writer.add({ ...b, bytes });
    if (++n % 50000 === 0)
      progress(`Copied ${n.toLocaleString()} existing blocks…`);
  }
  progress("Partitioning the walking graph…");
  const cells = await addRoutingCells(
    writer,
    await reader.block(routing.block),
  );
  const { snapshot, ...manifest } = reader.index.manifest;
  const bytes = await writer.finish({
    ...manifest,
    routing: { ...routing, cells },
    capabilities: [
      ...manifest.capabilities,
      ...(cells ? ["paged-walking-routing"] : []),
    ],
  });
  return {
    file: output,
    bytes,
    cells: cells?.count ?? 0,
    parentSnapshot: snapshot,
  };
}
