import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AtlasReader, FileSource } from "../../format/src/reader";
import {
  isRoutingCell,
  sha256,
  TRANSPORT_MODES,
  type TransportMetadata,
  type TransportMode,
} from "../../format/src/index";
import { DiskWriter } from "./disk-writer";
import { addRoutingCellFile } from "./routing-cells";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export async function addTransport(
  writer: DiskWriter,
  input: string,
  modes: readonly TransportMode[] = TRANSPORT_MODES,
): Promise<TransportMetadata> {
  const temp = await mkdtemp(join(tmpdir(), "atlas-transport-"));
  try {
    const build = Bun.spawn(
      [
        "cargo",
        "build",
        "--release",
        "-p",
        "atlas-osm-import",
        "--bin",
        "transport-import",
      ],
      { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if (await build.exited) throw new Error("Transport compiler build failed");
    const process = Bun.spawn(
      [join(ROOT, "target/release/transport-import"), input, temp],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (await process.exited) throw new Error("Transport import failed");
    const stats = await Bun.file(join(temp, "metadata.json")).json();
    const profiles = {} as TransportMetadata["profiles"];
    for (const mode of modes) {
      console.log(`Partitioning ${mode} cells…`);
      const prefix = `routing/${mode}/cells`;
      const cells = await addRoutingCellFile(
        writer,
        join(temp, `${mode}.rte`),
        prefix,
      );
      await rm(join(temp, `${mode}.rte`));
      const { bytes, ...counts } = stats[mode];
      profiles[mode] = {
        ...counts,
        prefix,
        zoom: 14,
        count: cells?.count ?? 0,
        codec: "rcl2",
      };
    }
    return { version: 1, profiles };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function upgradeTransport(
  input: string,
  pbf: string,
  output: string,
  maxBytes: number,
) {
  const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
  const sourceHash = await sha256(
    new Uint8Array(await Bun.file(pbf).arrayBuffer()),
  );
  if (sourceHash !== reader.index.manifest.source.sha256)
    throw new Error("PBF digest differs from this package's source");
  const writer = await new DiskWriter(output, maxBytes).open();
  let copied = 0;
  for (const b of await reader.allBlocks()) {
    if (isRoutingCell(b.key)) continue;
    const offset = reader.index.header.payloadOffset + b.offset;
    const bytes = await reader.source.read(offset, offset + b.length);
    if ((await sha256(bytes)) !== b.hash)
      throw new Error(`Integrity check failed: ${b.key}`);
    await writer.add({ ...b, bytes });
    if (++copied % 50000 === 0)
      console.log(`Copied ${copied} existing blocks…`);
  }
  const transport = await addTransport(writer, pbf);
  const { snapshot, ...manifest } = reader.index.manifest;
  if (manifest.routing) delete manifest.routing.cells;
  const bytes = await writer.finish({
    ...manifest,
    transport,
    capabilities: [
      ...manifest.capabilities.filter(
        (c) => !["paged-walking-routing", "transport-routing"].includes(c),
      ),
      "transport-routing",
    ],
    limitations: [
      ...manifest.limitations.filter((l) => !l.startsWith("Walking-v1 only")),
      "Transport-v1 uses estimated directional speeds and common via-node turn restrictions. Conditional and unsupported turn restrictions conservatively exclude their incoming ways. No live traffic, terrain, schedules, or country-specific access defaults.",
      "Isochrones are approximate envelopes around the reachable road network; polygon interiors are not guaranteed traversable.",
    ],
  });
  return { file: output, bytes, transport, parentSnapshot: snapshot };
}
