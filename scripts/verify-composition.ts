/** Verify the prepared shared-graph demo without loading display payloads. */
import { PackageSource } from "../apps/server/package-source";
import { AtlasReader } from "../packages/format/src/reader";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { TRANSPORT_MODES } from "../packages/format/src/index";
const root = new URL("../", import.meta.url);
const recipe = await Bun.file(
  new URL(process.argv[2] ?? "data/danube-composition.json", root),
).json();
const sources = [];
try {
  for (const job of recipe.jobs) {
    const file = await PackageSource.open(
      new URL(`data/hosted/${job.id}.atlas`, root).pathname,
    );
    const reader = await new AtlasReader(file, undefined, {
      purposes: ["routing"],
    }).open();
    sources.push({ id: job.id, reader, file });
    const m = reader.index.manifest;
    if (m.minZoom !== 0 || m.maxZoom !== 16 || !m.transport)
      throw new Error("Expected z0–16 with transport data");
    console.log(
      m.name,
      `${(file.size / 2 ** 30).toFixed(3)} GiB`,
      m.capabilities.join(", "),
    );
  }
  const hashes = new Map<string, string>();
  let overlaps = 0;
  for (const { reader } of sources)
    for (const mode of TRANSPORT_MODES) {
      const profile = reader.index.manifest.transport!.profiles[mode];
      if (!profile) throw new Error(`Missing ${mode}`);
      for (const b of await reader.spatial(
        profile.prefix,
        14,
        0,
        16383,
        0,
        16383,
      )) {
        const old = hashes.get(b.key);
        if (old && old !== b.hash)
          throw new Error(`Graph seam conflict: ${b.key}`);
        if (old) overlaps++;
        hashes.set(b.key, b.hash);
      }
    }
  console.log(
    `${overlaps} repeated routing cells match across packages; ${hashes.size} distinct cells.`,
  );
  initSync({
    module: await Bun.file(
      new URL("packages/routing/pkg/atlas_routing_wasm_bg.wasm", root),
    ).arrayBuffer(),
  });
  const results = [];
  for (const mode of ["driving", "cycling", "walking"] as const) {
    const provider = new RoutingComposition(sources);
    let last = 0;
    const router = new PagedRouter(
      provider.snapshot,
      (key) => provider.read(key),
      (p) => {
        if (Date.now() - last > 5000) {
          console.log(
            mode,
            p.phase,
            p.visited,
            "states",
            p.loadedCells,
            "cells",
          );
          last = Date.now();
        }
      },
      async () => {},
      { searchStates: 2_000_000 },
    );
    try {
      const result = await router.route(
        [16.3696, 48.2027],
        [17.1128, 48.1452],
        mode,
        provider.prefix(mode),
      );
      const owners = Object.fromEntries(
        sources.map((s) => [
          s.reader.index.manifest.name,
          [...provider.served.values()].filter((v) => v.source === s.id).length,
        ]),
      );
      const summary = {
        ...result,
        coordinates: undefined,
        wayIds: undefined,
        cells: undefined,
        owners,
      };
      results.push(summary);
      console.log(JSON.stringify(summary));
      if (result.status !== "found")
        throw new Error(`${mode} did not finish: ${result.status}`);
      if (Object.values(owners).filter((n) => n > 0).length < 2)
        throw new Error("Route did not use multiple packages");
    } finally {
      router.destroy();
    }
  }
  await Bun.write(
    new URL("data/danube-verification.json", root),
    JSON.stringify(
      { verifiedAt: new Date().toISOString(), overlaps, results },
      null,
      2,
    ),
  );
} finally {
  for (const s of sources) {
    s.reader.dispose();
    await s.file.close();
  }
}
