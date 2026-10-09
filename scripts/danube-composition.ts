/** A resumable, sequential four-package build from a single compiled graph.
 * Uses the pinned regional inputs already cached by data:vienna. No network calls.
 * Output size is measured, not achieved by padding or dropping capabilities. */
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DiskWriter } from "../packages/cli/src/disk-writer";
import { addTransport } from "../packages/cli/src/transport";
import { fileHash } from "../packages/cli/src/source";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { MAP_LAYERS, TRANSPORT_MODES } from "../packages/format/src/index";
import { FEATURE_KINDS } from "../packages/features/src/index";
import { preparePackage } from "../packages/provisioning/src/prepare";
import type { PackageSelection } from "../packages/provisioning/src/selection";
import type { PreparationJob } from "../apps/server/preparations";
const root = fileURLToPath(new URL("../", import.meta.url));
const GiB = 2 ** 30;
export const recipe = {
  version: 1,
  sourceDate: "2026-10-06",
  countries: ["austria", "slovakia", "hungary"],
  bounds: [14.1, 46.55, 19.6, 49.6],
  minZoom: 0,
  maxZoom: 16,
  targetBytes: GiB,
  maxBytes: 1.5 * GiB,
  chunks: [
    {
      key: "vienna",
      name: "Vienna & Lower Austria",
      bounds: [14.2, 48.0, 16.9, 49.5],
    },
    {
      key: "bratislava",
      name: "Bratislava & western Slovakia",
      bounds: [16.75, 48.0, 19.5, 49.5],
    },
    {
      key: "graz",
      name: "Graz & southern Austria",
      bounds: [14.2, 46.65, 16.9, 48.15],
    },
    {
      key: "gyor",
      name: "Győr, Budapest & western Hungary",
      bounds: [16.75, 46.65, 19.5, 48.15],
    },
  ],
};
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(recipe, null, 2));
  process.exit(0);
}
const work = resolve(root, "data/danube-build"),
  hosted = resolve(root, "data/hosted");
await mkdir(work, { recursive: true });
await mkdir(hosted, { recursive: true });
const saved = resolve(work, "recipe.json");
if (
  (await Bun.file(saved).exists()) &&
  JSON.stringify(await Bun.file(saved).json()) !== JSON.stringify(recipe)
)
  throw new Error("Build recipe changed. Use a new build directory.");
await Bun.write(saved, JSON.stringify(recipe, null, 2));
async function space(bytes = 3 * GiB) {
  const s = await statfs(work);
  if (s.bavail * s.bsize < bytes)
    throw new Error(
      `Build paused: need ${(bytes / GiB).toFixed(1)} GiB free workspace; ${((s.bavail * s.bsize) / GiB).toFixed(1)} GiB available. Re-run to resume.`,
    );
}
async function run(args: string[]) {
  console.log(args.slice(0, 3).join(" "));
  const p = Bun.spawn(args, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: work },
  });
  if (await p.exited) throw new Error(`Build step failed: ${args.join(" ")}`);
}
async function extract(input: string, output: string, bounds: number[]) {
  if (await Bun.file(output).exists()) return;
  await space();
  const part = output + ".part.pbf";
  await run([
    "osmium",
    "extract",
    input,
    `--bbox=${bounds.join(",")}`,
    "--strategy=smart",
    "-S",
    "types=multipolygon,restriction",
    "--set-bounds",
    "--overwrite",
    "-o",
    part,
  ]);
  await rename(part, output);
}
const merged = resolve(work, "danube.osm.pbf");
if (!(await Bun.file(merged).exists())) {
  const crops: string[] = [],
    inputs = [];
  for (const country of recipe.countries) {
    const input = resolve(root, `data/sources/${country}-261006.osm.pbf`);
    if (!(await Bun.file(input).exists()))
      throw new Error(`Missing pinned source: ${input}`);
    const receipt = await Bun.file(input + ".source.json").json();
    if ((await fileHash(input)) !== receipt.sha256)
      throw new Error("Cached source checksum mismatch");
    inputs.push({
      url: receipt.url,
      sha256: receipt.sha256,
      bytes: Bun.file(input).size,
    });
    const crop = resolve(work, country + ".osm.pbf");
    await extract(input, crop, recipe.bounds);
    crops.push(crop);
  }
  await run([
    "osmium",
    "merge",
    ...crops,
    "--overwrite",
    "-o",
    merged + ".part.pbf",
  ]);
  await run(["osmium", "check-refs", merged + ".part.pbf"]);
  await rename(merged + ".part.pbf", merged);
  await Bun.write(
    merged + ".source.json",
    JSON.stringify(
      {
        url: "https://download.geofabrik.de/europe.html",
        sha256: await fileHash(merged),
        inputs,
        extraction: {
          bounds: recipe.bounds,
          strategy: "smart; multipolygon,restriction",
          sourceDate: recipe.sourceDate,
        },
      },
      null,
      2,
    ),
  );
  for (const crop of crops) await rm(crop);
}
const source = await Bun.file(merged + ".source.json").json();
const graph = resolve(work, "transport.atlas");
if (!(await Bun.file(graph).exists())) {
  await space(7 * GiB);
  console.log("Compiling the shared three-mode graph…");
  const writer = await new DiskWriter(graph, 2 * GiB).open();
  try {
    const transport = await addTransport(writer, merged);
    await writer.finish({
      format: "atlas",
      version: 1,
      name: "Danube shared transport graph",
      source: {
        ...source,
        attribution: "© OpenStreetMap contributors · ODbL 1.0",
      },
      bounds: recipe.bounds as [number, number, number, number],
      minZoom: 0,
      maxZoom: 16,
      features: 0,
      peaks: 0,
      places: [],
      transport,
      capabilities: ["transport-routing"],
      limitations: [
        "Regional input coverage: Austria, Slovakia and Hungary only; neighbouring countries are not included.",
      ],
    });
  } catch (e) {
    await writer.abort();
    throw e;
  }
}
const graphReader = await new AtlasReader(
    new FileSource(Bun.file(graph)),
  ).open(),
  graphSnapshot = graphReader.index.manifest.snapshot;
graphReader.dispose();
console.log(
  "SHARED GRAPH",
  graphSnapshot,
  (Bun.file(graph).size / GiB).toFixed(3),
  "GiB",
);
if (process.argv.includes("--graph-only")) process.exit(0);
const jobs: PreparationJob[] = [];
for (const chunk of recipe.chunks) {
  const record = resolve(work, chunk.key + ".job.json");
  if (await Bun.file(record).exists()) {
    const job = await Bun.file(record).json();
    if (await Bun.file(resolve(hosted, job.id + ".atlas")).exists()) {
      jobs.push(job);
      continue;
    }
  }
  await space(5 * GiB);
  const [w, s, e, n] = chunk.bounds as [number, number, number, number];
  const selection: PackageSelection = {
    snapshot: "geofabrik",
    name: chunk.name,
    polygon: [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ],
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
    paddingCells: 2,
    maxBytes: recipe.maxBytes,
  };
  const input = resolve(work, chunk.key + ".osm.pbf"),
    compiled = resolve(work, chunk.key + ".atlas"),
    selected = resolve(work, chunk.key + ".selection.json");
  await extract(merged, input, [w - 0.06, s - 0.04, e + 0.06, n + 0.04]);
  await Bun.write(
    input + ".source.json",
    JSON.stringify({
      ...source,
      url: "shared Danube source: " + source.sha256,
      extraction: { ...source.extraction, bounds: chunk.bounds },
    }),
  );
  await Bun.write(selected, JSON.stringify(selection));
  console.log(
    `COMPILING ${chunk.name}: ${(Bun.file(input).size / 2 ** 20).toFixed(1)} MiB PBF`,
  );
  if (!(await Bun.file(compiled).exists()))
    await run([
      process.execPath,
      "packages/cli/src/index.ts",
      "generate",
      "--input",
      input,
      "--output",
      compiled,
      "--name",
      chunk.name,
      "--min-zoom",
      "0",
      "--max-zoom",
      "16",
      "--bounds",
      [w - 0.06, s - 0.04, e + 0.06, n + 0.04].join(","),
      "--selection",
      selected,
      "--transport-from",
      graph,
      "--max-bytes",
      String(2 * GiB),
      "--no-source-features",
      "--features",
    ]);
  for (const suffix of [".import.json", ".import.json.routing.bin"])
    await rm(compiled + suffix, { force: true });
  const reader = await new AtlasReader(
    new FileSource(Bun.file(compiled)),
  ).open();
  const id = crypto.randomUUID(),
    output = resolve(hosted, id + ".atlas");
  let last = 0;
  const finalSelection = {
    ...selection,
    snapshot: reader.index.manifest.snapshot,
  };
  const prepared = await preparePackage(
    reader,
    finalSelection,
    output,
    new AbortController().signal,
    (p) => {
      if (Date.now() - last > 5000) {
        console.log(
          `${chunk.name}: ${p.phase} ${p.completed}/${p.total}, ${(p.writtenBytes / GiB).toFixed(2)} GiB`,
        );
        last = Date.now();
      }
    },
  );
  reader.dispose();
  const final = await new AtlasReader(new FileSource(Bun.file(output))).open();
  if (final.index.manifest.transport?.graphSnapshot !== graphSnapshot)
    throw new Error("Shared graph identity lost");
  const job: PreparationJob = {
    id,
    name: chunk.name,
    createdAt: new Date().toISOString(),
    state: "ready",
    selection: finalSelection,
    size: prepared.size,
    manifest: final.index.manifest,
    progress: {
      phase: "verifying",
      message: "Ready to serve and download.",
      completed: 1,
      total: 1,
      readBytes: 0,
      writtenBytes: prepared.size,
    },
  };
  final.dispose();
  await Bun.write(record, JSON.stringify(job, null, 2));
  jobs.push(job);
  await rm(compiled);
  await rm(input);
  console.log(`READY ${chunk.name}: ${(prepared.size / GiB).toFixed(3)} GiB`);
}
// Publish only after all four finished. Existing library records stay intact until the operator switches the demo.
for (const job of jobs)
  await Bun.write(resolve(hosted, job.id + ".json"), JSON.stringify(job));
const composition = {
  version: 1,
  catalogs: ["http://127.0.0.1:3100/catalog"],
  sources: jobs.map((j) => ({
    url: `http://127.0.0.1:3100/maps/${j.id}.atlas`,
    enabled: true,
    layers: j.manifest!.tileLayers,
    labels: true,
  })),
  style: "paper",
  coverage: true,
};
await Bun.write(
  resolve(root, "data/danube-composition.json"),
  JSON.stringify(
    {
      recipe,
      graphSnapshot,
      jobs: jobs.map((j) => ({ id: j.id, name: j.name, bytes: j.size })),
      composition,
    },
    null,
    2,
  ),
);
console.log(
  "COMPOSITION READY",
  jobs.reduce((n, j) => n + j.size!, 0) / GiB,
  "GiB",
);
console.log(
  "http://127.0.0.1:3100/compose#view=" +
    encodeURIComponent(JSON.stringify(composition)),
);
