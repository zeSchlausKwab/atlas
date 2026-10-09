/** Real Vienna smoke check. Run after build:wasm; reads only explored routing cells. */
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasRouter, type Position } from "../packages/routing/src/index";
import { TRANSPORT_MODES } from "../packages/format/src/index";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
const file = process.argv[2] ?? "data/vienna-plus.atlas";
initSync({
  module: await Bun.file(
    new URL("../packages/routing/pkg/atlas_routing_wasm_bg.wasm", import.meta.url),
  ).arrayBuffer(),
});
const reader = await new AtlasReader(new FileSource(Bun.file(file))).open();
if (!reader.index.manifest.transport)
  throw Error("Compile transport profiles first");
const router = new AtlasRouter(reader, async () => {});
const start: Position = [16.3605, 48.2145],
  end: Position = [16.3918, 48.2194];
const results = [];
try {
  for (const profile of TRANSPORT_MODES) {
    const route = await router.route(start, end, profile),
      area = await router.isochrone(start, [300, 600, 900], profile);
    if (route.status !== "found" || area.status !== "reachable")
      throw Error(`${profile}: ${route.status} / ${area.status}`);
    const again = await router.isochrone(start, [300, 600, 900], profile);
    if (
      again.status !== "reachable" ||
      JSON.stringify(again.contours) !== JSON.stringify(area.contours) ||
      again.graphBytes !== 0
    )
      throw Error(`${profile}: cached contour mismatch`);
    results.push({
      profile,
      meters: route.meters,
      seconds: route.seconds,
      routeCells: route.cells?.loadedCells,
      areaCells: area.cells?.loadedCells,
      areaAdditionalBytes: area.graphBytes,
      areaComputeMs: area.computeMs,
      reachableSegments: area.segments,
    });
  }
  console.log(
    JSON.stringify(
      {
        snapshot: reader.index.manifest.snapshot,
        bytes: reader.index.header.fileLength,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  router.destroy();
}
