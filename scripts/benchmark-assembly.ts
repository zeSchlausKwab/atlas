/** Synthetic CPU/local-I/O comparison, not a NAS throughput prediction. */
import { mkdtemp, rm } from "node:fs/promises";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import { copyArchiveBlocks } from "../packages/cli/src/archive-copy";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import type { Manifest } from "../packages/format/src/index";
const dir = await mkdtemp("/tmp/atlas-assembly-bench-");
const m: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "assembly benchmark",
  source: { url: "synthetic", sha256: "0".repeat(64), attribution: "fixture" },
  bounds: [-180, -85, 180, 85],
  minZoom: 6,
  maxZoom: 6,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  tileLayers: ["water"],
  limitations: [],
};
try {
  const source = await new StreamWriter(
    dir + "/source.atlas",
    Number.MAX_SAFE_INTEGER,
  ).open();
  // Mixed, compressible records across all 32x32 directory leaves.
  for (let x = 0; x < 64; x++)
    for (let y = 0; y < 64; y++) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          x,
          y,
          coordinates: Array.from({ length: 4096 }, (_, i) => [
            i % 300,
            (i * 7 + x) % 800,
          ]),
        }),
      );
      await source.add({ key: `tile/water/6/${x}/${y}`, bytes });
    }
  await source.finish(m);
  for (const method of ["decode-recompress", "verified-stored-copy"] as const) {
    const w = await new StreamWriter(
      dir + `/${method}.atlas`,
      Number.MAX_SAFE_INTEGER,
    ).open();
    const started = performance.now();
    let io: unknown;
    if (method === "decode-recompress") {
      const r = await new AtlasReader(
        new FileSource(Bun.file(dir + "/source.atlas")),
      ).open();
      for await (const block of r.iterateBlocks()) {
        const { codec, rawLength, ...b } = block;
        await w.add({ ...b, bytes: await r.block(block.key) });
      }
      r.dispose();
    } else
      io = await copyArchiveBlocks(
        dir + "/source.atlas",
        w,
        new AbortController().signal,
      );
    await w.finish(m);
    console.log(
      JSON.stringify({
        method,
        seconds: (performance.now() - started) / 1000,
        sourceBytes: Bun.file(dir + "/source.atlas").size,
        outputBytes: Bun.file(dir + `/${method}.atlas`).size,
        ...(io
          ? { reads: (io as any).readCalls, readBytes: (io as any).readBytes }
          : {}),
      }),
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
