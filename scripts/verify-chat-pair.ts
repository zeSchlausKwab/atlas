/** Repeat the chat's data proof against two existing archives; no model/API key required. */
import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
const paths = process.argv.slice(2);
if (!paths.length)
  paths.push(
    "data/pair-rehearsal/west-paged.atlas",
    "data/pair-rehearsal/east-paged.atlas",
  );
if (paths.length !== 2)
  throw new Error("Provide two Vienna rehearsal .atlas paths");
let reads = 0;
const readers: AtlasReader[] = [];
let runtime: ChatDataRuntime | undefined;
try {
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists()))
      throw new Error(
        "Missing " +
          path +
          "; build/repage the Vienna rehearsal first (docs/FEATURE-PAGING.md)",
      );
    const source = new FileSource(file);
    readers.push(
      await new AtlasReader({
        read: (a, b) => {
          reads++;
          return source.read(a, b);
        },
      }).open(),
    );
  }
  runtime = new ChatDataRuntime(readers);
  const invoke = (n: string, i: unknown) =>
    runtime!.invoke(n, i, new AbortController().signal);
  const prepared = await invoke("workspace_prepare", {
    bounds: [16.368, 48.198, 16.392, 48.218],
    families: ["buildings"],
    geometry: true,
  });
  assert.equal(prepared.records, 3260);
  assert.equal(prepared.coverage.status, "complete");
  assert.equal(prepared.snapshots.length, 2);
  const before = reads;
  const all = await invoke("workspace_query", {
    workspace: prepared.workspace,
  });
  const heights = await invoke("analyze", {
    result: all.result,
    operation: "stats",
    field: "heightMeters",
  });
  const sources = await invoke("analyze", {
    result: all.result,
    operation: "group",
    field: "heightSource",
  });
  assert.equal(heights.unknown, 385);
  const tall = await invoke("workspace_query", {
    workspace: prepared.workspace,
    where: [{ field: "heightMeters", op: "gte", value: 20 }],
  });
  assert.equal(tall.count, 1511);
  assert.equal(
    (await runtime.resolve(tall.result)).collection.features.length,
    1511,
  );
  const taller = await invoke("workspace_query", {
    workspace: prepared.workspace,
    from: tall.result,
    where: [{ field: "heightMeters", op: "gte", value: 30 }],
  });
  assert.equal(taller.count, 512);
  assert.equal(
    (await runtime.resolve(taller.result)).collection.features.length,
    512,
  );
  assert.equal(reads, before);
  const address = await invoke("search", { query: "Handelskai 300", limit: 8 });
  assert.equal(address.matches[0].address.houseNumber, "300");
  assert.equal(address.truncated, false);
  initSync({
    module: await Bun.file(
      "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
    ).arrayBuffer(),
  });
  const routes = [];
  for (const mode of ["walking", "cycling", "driving"] as const) {
    const composition = new RoutingComposition(
      readers.map((reader, i) => ({ id: String(i), reader })),
    );
    const router = new PagedRouter(
      composition.snapshot,
      (k) => composition.read(k),
      () => {},
      async () => {},
      { searchStates: 2_000_000 },
    );
    try {
      const r = await router.route(
        [16.339906985455155, 48.204992784534],
        [16.4218088, 48.2131002],
        mode,
        composition.prefix(mode),
      );
      assert.equal(r.status, "found");
      const providers = [
        ...new Set([...composition.served.values()].map((s) => s.source)),
      ];
      assert.equal(providers.length, 2);
      routes.push({
        mode,
        status: r.status,
        providers,
        meters: r.status === "found" ? r.meters : null,
      });
    } finally {
      router.destroy();
    }
  }
  console.log(
    JSON.stringify(
      {
        files: paths,
        records: prepared.records,
        readBytes: prepared.readBytes,
        memoryEstimateBytes: prepared.memoryEstimateBytes,
        heightKnown: heights.known,
        heightUnknown: heights.unknown,
        heightSources: sources.groups,
        atLeast20: tall.count,
        atLeast30: taller.count,
        followUpSourceReads: 0,
        address: address.matches[0],
        routes,
      },
      null,
      2,
    ),
  );
} finally {
  runtime?.clear();
  readers.forEach((r) => r.dispose());
}
