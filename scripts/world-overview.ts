import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildWorldOverview } from "../packages/provisioning/src/world-overview";
const output = resolve(process.argv[2] ?? "data/world-overview.atlas");
await mkdir(dirname(output), { recursive: true });
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
let last = 0;
const started = performance.now();
const result = await buildWorldOverview(
  resolve(process.argv[3] ?? "data/natural-earth"),
  output,
  "World overview · Natural Earth",
  abort.signal,
  (p) => {
    if (
      performance.now() - last > 1000 ||
      (p.total && p.total === p.completed)
    ) {
      console.log(`${p.message}: ${p.completed}/${p.total || "?"}`);
      last = performance.now();
    }
  },
);
console.log(
  JSON.stringify({
    output,
    bytes: result.size,
    snapshot: result.manifest.snapshot,
    seconds: (performance.now() - started) / 1000,
  }),
);
