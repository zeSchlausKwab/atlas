#!/usr/bin/env bun
import { packRaster } from "../packages/raster/src/pack";
const args = process.argv.slice(2),
  value = (key: string) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
if (args.includes("--help")) {
  console.log(
    "bun run raster:import --tiles XYZ_DIRECTORY --descriptor LAYER.json --output NEW.atlas [--max-mib 1024]",
  );
  process.exit(0);
}
const tiles = value("--tiles"),
  descriptor = value("--descriptor"),
  output = value("--output");
if (!tiles || !descriptor || !output)
  throw new Error("Provide --tiles, --descriptor and --output; see --help");
const max = Number(value("--max-mib") ?? 1024);
if (!Number.isSafeInteger(max) || max < 1) throw new Error("Invalid --max-mib");
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(
  await packRaster(
    tiles,
    await Bun.file(descriptor).json(),
    output,
    max * 1024 ** 2,
    abort.signal,
  ),
);
