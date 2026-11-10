#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { packRaster } from "../packages/raster/src/pack";
import {
  inspectMbtiles,
  importMbtiles,
  type MbtilesOptions,
} from "../packages/raster/src/mbtiles";
const help = `Import pre-tiled imagery into a new, self-contained Atlas archive.

bun run raster:import --mbtiles INPUT.mbtiles --output NEW.atlas [options]
bun run raster:import --mbtiles INPUT.mbtiles --dry-run [--format json]
bun run raster:import --tiles XYZ_DIRECTORY --descriptor LAYER.json --output NEW.atlas

MBTiles: JPEG/PNG, 256/512 px, Mercator, TMS rows (explicit scheme=xyz also supported).
  --id ID                  Layer ID (default: imagery)
  --name NAME              Override metadata name
  --bounds W,S,E,N         Override/missing coverage in longitude,latitude
  --attribution TEXT       Override metadata credit
  --license TEXT           Override metadata licence; never inferred
  --dry-run                Inspect MBTiles without creating any output
  --max-mib MIB            Optional output ceiling (no default cap for MBTiles)
  --format json|md         Machine-readable result or human summary (default: md)
  --help                   Show this help

Input is read-only. Existing outputs are never overwritten. Progress goes to stderr.
XYZ imports use the descriptor and retain their existing 1024 MiB default ceiling.`;
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
try {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      help: { type: "boolean" },
      "dry-run": { type: "boolean" },
      ...Object.fromEntries(
        [
          "mbtiles",
          "tiles",
          "descriptor",
          "output",
          "id",
          "name",
          "bounds",
          "attribution",
          "license",
          "max-mib",
          "format",
        ].map((k) => [k, { type: "string" as const }]),
      ),
    },
  });
  const v = parsed.values as Record<string, string | boolean | undefined>;
  if (v.help) {
    console.log(help);
    process.exit(0);
  }
  const str = (key: string) =>
    typeof v[key] === "string" ? (v[key] as string) : undefined;
  const format = str("format") ?? "md";
  if (!["json", "md"].includes(format))
    throw new Error("--format must be json or md");
  if (!!v.mbtiles === !!v.tiles)
    throw new Error("Choose exactly one of --mbtiles or --tiles; see --help");
  const output = str("output");
  if (!v["dry-run"] && !output)
    throw new Error("Provide --output NEW.atlas (or --dry-run for MBTiles)");
  const mib = str("max-mib"),
    max =
      mib === undefined
        ? v.mbtiles
          ? Number.MAX_SAFE_INTEGER
          : 1024 ** 3
        : Number(mib) * 1024 ** 2;
  if (!Number.isSafeInteger(max) || max < 1)
    throw new Error("--max-mib must be a positive size representable in bytes");
  let result: unknown;
  if (v.mbtiles) {
    if (v.descriptor)
      throw new Error(
        "--descriptor belongs to XYZ imports; use MBTiles metadata overrides instead",
      );
    const options: MbtilesOptions = {
      id: str("id"),
      name: str("name"),
      attribution: str("attribution"),
      license: str("license"),
      bounds: str("bounds")?.split(",").map(Number) as MbtilesOptions["bounds"],
    };
    let phase = "",
      start = performance.now(),
      last = 0;
    result = v["dry-run"]
      ? await inspectMbtiles(str("mbtiles")!, options)
      : await importMbtiles(
          str("mbtiles")!,
          output!,
          options,
          max,
          abort.signal,
          (p) => {
            if (phase !== p.phase) {
              phase = p.phase;
              start = performance.now();
              last = 0;
            }
            const now = performance.now();
            if (last && now - last < 1000 && p.completed !== p.total) return;
            last = now;
            const eta = p.completed
              ? (((now - start) / p.completed) * (p.total - p.completed)) / 1000
              : undefined;
            console.error(
              `${phase}: ${p.completed.toLocaleString()}/${p.total.toLocaleString()} (${((100 * p.completed) / Math.max(1, p.total)).toFixed(1)}%)${eta !== undefined && now - start > 1000 ? ` · ~${Math.ceil(eta)}s remaining in this pass` : ""}`,
            );
          },
        );
  } else {
    if (v["dry-run"])
      throw new Error("--dry-run currently supports MBTiles inputs only");
    if (!v.descriptor)
      throw new Error("XYZ import needs --descriptor LAYER.json");
    result = await packRaster(
      str("tiles")!,
      await Bun.file(str("descriptor")!).json(),
      output!,
      max,
      abort.signal,
    );
  }
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else {
    const r = result as Awaited<ReturnType<typeof importMbtiles>>;
    console.log(
      `${v["dry-run"] ? "Inspected" : "Imported"}: ${r.layer?.name ?? output}\n${r.tiles.toLocaleString()} tiles${r.layer ? ` · ${r.layer.encoding.toUpperCase()} ${r.layer.tileSize}px · z${r.layer.minZoom}–${r.layer.maxZoom}` : ""}`,
    );
    if (r.size)
      console.log(`${(r.size / 1024 ** 2).toFixed(2)} MiB → ${output}`);
    else if (r.estimatedOutputBytes)
      console.log(
        `Estimated output: ${(r.estimatedOutputBytes / 1024 ** 2).toFixed(2)} MiB`,
      );
    for (const warning of r.warnings ?? []) console.log(warning);
  }
} catch (e) {
  console.error(
    abort.signal.aborted
      ? "Import cancelled; input preserved."
      : `Raster import: ${e instanceof Error ? e.message : e}`,
  );
  process.exitCode = abort.signal.aborted ? 130 : 1;
}
