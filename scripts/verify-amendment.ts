#!/usr/bin/env bun
/** Reproducible local proof: geometry/extraction first, then independently add routing. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { preparePackage } from "../packages/provisioning/src/prepare";
import {
  availability,
  type PackageSelection,
} from "../packages/provisioning/src/selection";
import {
  amendRouting,
  type RoutingAmendment,
} from "../packages/provisioning/src/amend";
import { AtlasEngine } from "../packages/operations/src/index";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { createApiHandler } from "../apps/server/api";
const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
if (args.includes("--help")) {
  console.log(
    "bun run verify:amendment [--source data/local-demo.atlas] [--work NEW_DIRECTORY]",
  );
  process.exit(0);
}
const work = option("--work")
  ? resolve(option("--work")!)
  : await mkdtemp("/tmp/atlas-amend-demo-");
await mkdir(work, { recursive: true });
const source = await new AtlasReader(
  new FileSource(
    Bun.file(resolve(option("--source") ?? "data/local-demo.atlas")),
  ),
).open();
const m = source.index.manifest,
  a = availability(m),
  b = m.bounds;
const selection: PackageSelection = {
  snapshot: m.snapshot,
  name: "Geometry & extraction · amendment demo",
  polygon: [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
  ],
  minZoom: m.minZoom,
  maxZoom: m.maxZoom,
  layers: a.layers,
  featureKinds: a.featureKinds,
  placeNames: a.labels,
  streetNames: a.labels,
  pois: a.labels,
  profiles: [],
  search: false,
  reverse: false,
  peaks: false,
  paddingCells: 1,
  maxBytes: source.index.header.fileLength * 2 + 1024 ** 2,
};
assert(
  a.profiles.includes("walking"),
  "Use a source containing walking graph cells",
);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
const original = `${work}/original.atlas`,
  output = `${work}/amended.atlas`;
assert(
  !(await Bun.file(original).exists()) && !(await Bun.file(output).exists()),
  "Use a fresh work directory",
);
console.error(
  "Preparing a geometry/extraction-only archive from the local sample…",
);
await preparePackage(source, selection, original, controller.signal, () => {});
const target = await new AtlasReader(new FileSource(Bun.file(original))).open();
const options: RoutingAmendment = {
  targetSnapshot: target.index.manifest.snapshot,
  sourceSnapshot: m.snapshot,
  name: "Geometry, extraction & routing · amendment demo",
  profiles: [...a.profiles],
  paddingCells: 1,
  maxBytes: selection.maxBytes,
};
console.error(
  "Adding routing while verifying and copying the original payload…",
);
const started = performance.now();
const result = await amendRouting(
  target,
  source,
  options,
  output,
  controller.signal,
);
const amendmentMs = performance.now() - started;
const amended = await new AtlasReader(new FileSource(Bun.file(output))).open();
let preserved = 0;
const next = new Map((await amended.allBlocks()).map((b) => [b.key, b]));
for await (const block of target.iterateBlocks()) {
  const same = next.get(block.key);
  assert(same);
  assert.equal(same.hash, block.hash);
  assert.equal(same.codec, block.codec);
  assert.equal(same.rawLength, block.rawLength);
  preserved++;
}
// Choose a real retained walking edge as a reproducible route, without assuming a city name.
let start: [number, number] | undefined, end: [number, number] | undefined;
for await (const block of amended.iterateBlocks()) {
  if (!block.key.startsWith("routing/walking/cells/")) continue;
  const raw = await amended.block(block.key),
    v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    nodes = v.getUint32(20, true),
    segments = v.getUint32(24, true);
  if (!segments) continue;
  const edge = 36 + nodes * 24,
    from = v.getUint32(edge, true),
    to = v.getUint32(edge + 4, true);
  start = [
    v.getFloat64(36 + from * 24 + 8, true),
    v.getFloat64(36 + from * 24 + 16, true),
  ];
  end = [
    v.getFloat64(36 + to * 24 + 8, true),
    v.getFloat64(36 + to * 24 + 16, true),
  ];
  break;
}
assert(start && end, "No testable walking edge");
initSync({
  module: await Bun.file(
    new URL(
      "../packages/routing/pkg/atlas_routing_wasm_bg.wasm",
      import.meta.url,
    ),
  ).arrayBuffer(),
});
const engine = new AtlasEngine(amended, async () => {}),
  donorEngine = new AtlasEngine(source, async () => {});
try {
  const route = await engine.route(start, end, "walking"),
    expected = await donorEngine.route(start, end, "walking");
  assert.equal(route.status, "found");
  assert.equal(expected.status, "found");
  if (route.status === "found" && expected.status === "found") {
    assert.deepEqual(route.coordinates, expected.coordinates);
    assert.equal(route.meters, expected.meters);
    assert.equal(route.seconds, expected.seconds);
  }
  const api = createApiHandler(engine),
    response = await api(
      new Request("http://localhost/api/route", {
        method: "POST",
        body: JSON.stringify({
          snapshot: amended.index.manifest.snapshot,
          input: { start, end, profile: "walking" },
        }),
      }),
    );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.status, "found");
  const report = {
    source: m.name,
    work,
    originalBytes: target.index.header.fileLength,
    amendedBytes: result.size,
    preservedBlocks: preserved,
    routingCells: result.plan.addition.blocks,
    routingBytes: result.plan.addition.bytes,
    amendmentMs,
    originalSnapshot: target.index.manifest.snapshot,
    amendedSnapshot: amended.index.manifest.snapshot,
    graphSnapshot: amended.index.manifest.transport!.graphSnapshot,
    route: {
      start,
      end,
      status: route.status,
      meters: route.status === "found" ? route.meters : undefined,
    },
    httpRouting: "passed",
    selection,
  };
  await Bun.write(`${work}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  engine.destroy();
  donorEngine.destroy();
  target.dispose();
  amended.dispose();
  source.dispose();
}
