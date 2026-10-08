import init from "../packages/renderer/pkg/atlas_renderer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasRouter, type Position } from "../packages/routing/src/index";
const path = process.argv[2] ?? "data/vienna-plus.atlas";
const initialize = () =>
  init({
    module_or_path: Bun.file(
      "packages/renderer/pkg/atlas_renderer_bg.wasm",
    ).arrayBuffer(),
  });
const source = new FileSource(Bun.file(path));
const reader = await new AtlasReader(source).open(),
  referenceReader = await new AtlasReader(source).open();
const router = new AtlasRouter(reader, initialize),
  reference = new AtlasRouter(referenceReader, initialize, { reference: true });
for (const [a, b] of [
  [
    [16.3731, 48.2085],
    [16.3918, 48.2194],
  ],
  [
    [16.3731, 48.2085],
    [16.3124, 48.1859],
  ],
  [
    [16.3124, 48.1859],
    [16.3731, 48.2085],
  ],
] as [Position, Position][]) {
  const result = await router.route(a, b),
    baseline = await reference.route(a, b);
  if (
    result.status !== baseline.status ||
    (result.status === "found" &&
      (baseline.status !== "found" ||
        Math.abs(result.meters - baseline.meters) > 1e-6))
  )
    throw new Error("Reference mismatch");
  console.log(
    JSON.stringify({
      status: result.status,
      meters: result.status === "found" ? result.meters : undefined,
      ...result.cells,
      cells: result.cells?.cells.length,
    }),
  );
}
console.log(
  "PASS: reference distances and statuses match; baseline stored bytes",
  referenceReader.bytesByPurpose.routing,
);
router.destroy();
reference.destroy();
