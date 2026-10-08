import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rename, mkdir } from "node:fs/promises";
import { fetchSource, fileHash } from "../packages/cli/src/source";
const root = fileURLToPath(new URL("../", import.meta.url));
const bounds = [15.55, 47.7, 17.35, 48.65];
const date = "261006";
const countries = ["austria", "slovakia", "hungary"];
const sourceBytes = [811818936, 345475164, 326433966];
const budget = 2_000_000_000;
const sources = countries.map((country, i) => ({
  country,
  url: `https://download.geofabrik.de/europe/${country}-${date}.osm.pbf`,
  bytes: sourceBytes[i]!,
}));
const recipe = {
  name: "Vienna Plus",
  bounds,
  sourceDate: "2026-10-06",
  sources,
  sourceBudgetBytes: budget,
  packageBudgetBytes: budget,
  minZoom: 0,
  maxZoom: 16,
  strategy: "complete_ways",
};
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(recipe, null, 2));
  process.exit(0);
}
if (sourceBytes.reduce((a, b) => a + b, 0) > budget)
  throw new Error("Source recipe exceeds 2 GB budget");
const osmium = Bun.which("osmium");
if (!osmium)
  throw new Error("Install osmium-tool first (brew install osmium-tool)");
await mkdir(resolve(root, "data/sources"), { recursive: true });
const inputs = await Promise.all(
  sources.map(async (source) => {
    const input = resolve(
      root,
      `data/sources/${source.country}-${date}.osm.pbf`,
    );
    const metadata = await fetchSource(source.url, input, source.bytes);
    if (metadata.bytes !== source.bytes)
      throw new Error(`Pinned source size mismatch: ${source.country}`);
    return { input, ...metadata };
  }),
);
async function run(args: string[]) {
  const p = Bun.spawn(args, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) throw new Error(`Failed: ${args[0]}`);
}
const cropped: string[] = [];
for (let i = 0; i < inputs.length; i++) {
  const out = resolve(root, `data/sources/${countries[i]}-vienna-plus.osm.pbf`);
  console.log(`Extracting Vienna region from ${countries[i]}…`);
  await run([
    osmium!,
    "extract",
    "--strategy=complete_ways",
    `--bbox=${bounds.join(",")}`,
    inputs[i]!.input,
    "--overwrite",
    "--output",
    out,
  ]);
  cropped.push(out);
}
const output = resolve(root, "data/vienna-plus.osm.pbf"),
  part = `${output}.part.pbf`;
await run([osmium, "merge", ...cropped, "--overwrite", "--output", part]);
await rename(part, output);
await run([osmium, "check-refs", output]);
const provenance = {
  url: "https://download.geofabrik.de/europe.html",
  sha256: await fileHash(output),
  inputs: inputs.map(({ url, sha256, bytes }) => ({ url, sha256, bytes })),
  extraction: {
    bounds,
    strategy: "complete_ways",
    sourceDate: recipe.sourceDate,
  },
};
await Bun.write(`${output}.source.json`, JSON.stringify(provenance, null, 2));
await Bun.write(
  resolve(root, "data/vienna-plus.recipe.json"),
  JSON.stringify(recipe, null, 2),
);
console.log(
  `Regional PBF: ${(Bun.file(output).size / 1e6).toFixed(1)} MB. Compiling ATLAS…`,
);
await run([
  process.execPath,
  "packages/cli/src/index.ts",
  "generate",
  "--input",
  output,
  "--output",
  resolve(root, "data/vienna-plus.atlas"),
  "--name",
  "Vienna Plus",
  "--min-zoom",
  "0",
  "--max-zoom",
  "16",
  "--max-bytes",
  String(budget),
  "--no-source-features",
  "--features",
]);
console.log(
  "Vienna Plus ready. Start with ATLAS_FILE=data/vienna-plus.atlas bun run start",
);
