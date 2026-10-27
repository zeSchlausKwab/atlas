/** One compiled root, two self-contained excerpts, real seam checks before publication. */
import assert from "node:assert/strict";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { MAP_LAYERS, TRANSPORT_MODES } from "../packages/format/src/index";
import { FEATURE_KINDS } from "../packages/features/src/index";
import { preparePackage } from "../packages/provisioning/src/prepare";
import type { PackageSelection } from "../packages/provisioning/src/selection";
import { AtlasGeocoder } from "../packages/geocoding/src/index";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import { buildTreeIndex, IndexedTree } from "../packages/hashtree/src/build";
import {
  HashtreeSource,
  type TreeOffer,
} from "../packages/hashtree/src/source";
const large = process.argv.includes("--large");
const arg = (key: string, fallback: string) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? fallback : process.argv[i + 1]!;
};
const work = resolve(
  arg("--work", large ? "data/central-pair" : "data/pair-rehearsal"),
);
const input = resolve(arg("--source", "data/vienna-plus.osm.pbf"));
const union = large ? [14.1, 47.0, 19.8, 49.4] : [16.3, 48.16, 16.46, 48.26];
const seam = large ? 16.8 : 16.38,
  overlap = large ? 0.1 : 0.005;
const bounds = [
  [union[0]!, union[1]!, seam + overlap, union[3]!],
  [seam - overlap, union[1]!, union[2]!, union[3]!],
];
const polygon = (b: number[]): [number, number][] => [
  [b[0]!, b[1]!],
  [b[2]!, b[1]!],
  [b[2]!, b[3]!],
  [b[0]!, b[3]!],
];
await mkdir(work, { recursive: true });
const recipe = {
  version: 1,
  input,
  union,
  bounds,
  maxZoom: 16,
  capabilities: "all-current",
  semantics: "osm-explicit-v1",
};
const recipeFile = Bun.file(`${work}/recipe.json`);
if (await recipeFile.exists())
  assert.deepEqual(
    await recipeFile.json(),
    recipe,
    "Use a new directory for a changed recipe",
  );
else await Bun.write(recipeFile, JSON.stringify(recipe, null, 2));
let statusWrite = Promise.resolve();
const status = (phase: string, message: string) => {
  console.log(message);
  const value = JSON.stringify({
    phase,
    message,
    updatedAt: new Date().toISOString(),
  });
  statusWrite = statusWrite.then(async () => {
    await Bun.write(`${work}/progress.json.part`, value);
    await rename(`${work}/progress.json.part`, `${work}/progress.json`);
  });
  return statusWrite;
};
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(recipe, null, 2));
  process.exit(0);
}
const area = `${work}/area.osm.pbf`,
  root = `${work}/root.atlas`;
if (!(await Bun.file(area).exists())) {
  await status(
    "extracting",
    "Extracting the shared area from the pinned PBF (three passes)",
  );
  const p = Bun.spawn(
    [
      "osmium",
      "extract",
      input,
      `--bbox=${union.join(",")}`,
      "--strategy=smart",
      "-S",
      "types=multipolygon,restriction",
      "--set-bounds",
      "--overwrite",
      "-o",
      area + ".part.osm.pbf",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await p.exited) throw Error("PBF extraction failed");
  await rename(area + ".part.osm.pbf", area);
}
const selection: PackageSelection = {
  snapshot: "0".repeat(64),
  name: large ? "Central Europe shared source" : "Vienna seam rehearsal",
  polygon: polygon(union),
  minZoom: 0,
  maxZoom: 16,
  layers: [...MAP_LAYERS],
  featureKinds: [...FEATURE_KINDS],
  placeNames: true,
  streetNames: true,
  pois: true,
  profiles: [...TRANSPORT_MODES],
  search: true,
  reverse: true,
  peaks: true,
  paddingCells: 1,
  maxBytes: (large ? 48 : 2) * 1024 ** 3,
};
if (!(await Bun.file(root).exists()))
  await compilePartitioned({
    input: area,
    output: root,
    work: `${work}/compiler`,
    selection,
    reserveBytes: large ? 12 * 1024 ** 3 : 2 * 1024 ** 3,
    workers: large ? 6 : 2,
    progress: (msg) => {
      void status("compiling", msg);
    },
  });
const source = await new AtlasReader(new FileSource(Bun.file(root))).open();
const files: string[] = [];
for (let i = 0; i < 2; i++) {
  const path = `${work}/${i === 0 ? "west" : "east"}.atlas`;
  files.push(path);
  if (!(await Bun.file(path).exists())) {
    await status(
      "splitting",
      `Preparing ${i === 0 ? "west" : "east"} with all capabilities`,
    );
    await preparePackage(
      source,
      {
        ...selection,
        snapshot: source.index.manifest.snapshot,
        name: large
          ? i === 0
            ? "Austria, Moravia & Vienna"
            : "Bratislava, western Slovakia & Hungary"
          : i === 0
            ? "Vienna west · rehearsal"
            : "Vienna east · rehearsal",
        polygon: polygon(bounds[i]!),
      },
      path,
      new AbortController().signal,
      () => {},
    );
  }
}
source.dispose();
const indexes: IndexedTree[] = [],
  transportSources: HashtreeSource[] = [],
  readers: AtlasReader[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  await status("verifying", "Indexing both maps and testing through Hashtree");
  for (const [i, path] of files.entries()) {
    const out = `${work}/${i}.hashtree.sqlite`;
    await buildTreeIndex(path, out);
    indexes.push(IndexedTree.open(out));
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const [i, hash] = new URL(req.url).pathname.slice(1).split("/");
      const bytes = await indexes[Number(i)]?.get(hash!);
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: 404 });
    },
  });
  for (const [i, index] of indexes.entries()) {
    const tree: TreeOffer = {
      version: 1,
      root: index.info.root,
      bytes: index.info.bytes,
      chunkBytes: index.info.chunkBytes,
      providers: [`${server.url.origin}/${i}`],
    };
    const transport = new HashtreeSource(
      `${server.url.origin}/map${i}.atlas`,
      tree,
    );
    transportSources.push(transport);
    readers.push(await new AtlasReader(transport).open());
  }
  assert(
    readers.every(
      (r) => r.index.manifest.semantics?.addresses === "osm-explicit",
    ),
  );
  const repeated = new Map<string, string>();
  let overlapCells = 0;
  for (const r of readers)
    for (const mode of TRANSPORT_MODES) {
      const prefix = r.index.manifest.transport!.profiles[mode]!.prefix;
      for (const b of await r.spatial(prefix, 14, 0, 16383, 0, 16383)) {
        const old = repeated.get(b.key);
        if (old) {
          assert.equal(old, b.hash);
          overlapCells++;
        }
        repeated.set(b.key, b.hash);
      }
    }
  assert(overlapCells > 0);
  initSync({
    module: await Bun.file(
      "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
    ).arrayBuffer(),
  });
  const routes = [];
  for (const mode of TRANSPORT_MODES) {
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
      const a: [number, number] = large
          ? [16.3696, 48.2027]
          : [16.339906985455155, 48.204992784534],
        b: [number, number] = large
          ? [17.1128, 48.1452]
          : [16.4218088, 48.2131002];
      const route = await router.route(a, b, mode, composition.prefix(mode));
      assert.equal(route.status, "found", `${mode} route failed`);
      const providers = [
        ...new Set([...composition.served.values()].map((v) => v.source)),
      ];
      assert.equal(providers.length, 2, `${mode} must use both maps`);
      routes.push({ mode, status: route.status, providers });
    } finally {
      router.destroy();
    }
  }
  const geocoder = new AtlasGeocoder(readers[large ? 0 : 1]!);
  const addressSearch = await geocoder.search(
    large ? "Kärntner Straße 1" : "Handelskai 300",
  );
  assert(
    addressSearch.matches.some(
      (m) => m.address?.houseNumber === (large ? "1" : "300"),
    ),
    "Exact house-number search",
  );
  const reverse = await geocoder.reverse(
    large ? [16.3696, 48.2027] : [16.4218088, 48.2131002],
  );
  assert(reverse.match, "Reverse geocoding finds a nearby street");
  // The Vienna seam in the dense rehearsal exercises address/feature cells together.
  const center = large ? [17, 48.15] : [16.38, 48.205];
  const workspace = new AtlasWorkspace(readers);
  const task = await workspace.prepare({
    bounds: [
      center[0]! - 0.002,
      center[1]! - 0.002,
      center[0]! + 0.002,
      center[1]! + 0.002,
    ],
    families: ["locations"],
    required: ["addresses", "poi-tags"],
  });
  const addresses = workspace.query({
    workspace: task.workspace,
    where: [{ field: "address.houseNumber", op: "exists", value: true }],
  });
  if (!large)
    assert(addresses.count > 0, "Rehearsal should contain explicit addresses");
  const before = transportSources.reduce((n, s) => n + s.networkBytes, 0);
  server.stop(true);
  const cached = workspace.query({ workspace: task.workspace });
  assert.equal(cached.sourceBytes, 0);
  assert.equal(
    transportSources.reduce((n, s) => n + s.networkBytes, 0),
    before,
  );
  workspace.clear();
  const result = {
    files: files.map((file, i) => ({
      file,
      bytes: Bun.file(file).size,
      manifest: readers[i]!.index.manifest,
    })),
    overlapCells,
    routes,
    addressSearch: addressSearch.matches[0]?.name,
    reverseStreet: reverse.match?.name,
    addressCount: addresses.count,
    workspace: {
      records: task.records,
      readBytes: task.readBytes,
      memoryEstimateBytes: task.memoryEstimateBytes,
    },
    hashtreeNetworkBytes: before,
    cacheOnlyQuery: true,
  };
  await Bun.write(`${work}/verified.json`, JSON.stringify(result, null, 2));
  await status(
    "ready",
    "Two complete maps verified: shared graph, all profiles, addresses, cross-map workspace and offline queries",
  );
  console.log(
    JSON.stringify(
      { ...result, files: result.files.map(({ manifest, ...f }) => f) },
      null,
      2,
    ),
  );
} finally {
  server?.stop(true);
  readers.forEach((r) => r.dispose());
  indexes.forEach((i) => i.close());
}
