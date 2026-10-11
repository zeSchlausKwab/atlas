/** Local deterministic benchmark; no live server or hosted data is read or modified. */
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import { compilerProgress } from "../packages/provisioning/src/compiler-progress";
import { compilerWorkers } from "../packages/compiler/src/settings";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { fileHash } from "../packages/cli/src/source";
import assert from "node:assert/strict";
const [mode = "search", input = "100000", workerList = "1,6"] =
  process.argv.slice(2);
const counts = workerList.split(",").map(compilerWorkers);
if (!["search", "fixture"].includes(mode))
  throw new Error(
    "Usage: bun scripts/benchmark-compiler.ts search RECORDS|fixture PBF [1,6]",
  );
const work = await mkdtemp("/tmp/atlas-parallel-benchmark-");
let reference: string | undefined;
console.log(
  JSON.stringify({
    hardware: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGiB: totalmem() / 1024 ** 3,
    bun: Bun.version,
    mode,
    input,
  }),
);
try {
  for (const workers of counts) {
    const timings: Record<string, number> = {};
    let stage = "start",
      stageStart = performance.now();
    const progress = (line: string) => {
      const p = compilerProgress(line);
      if (p?.stage && p.stage !== stage) {
        timings[stage] =
          (timings[stage] ?? 0) + (performance.now() - stageStart) / 1000;
        stage = p.stage;
        stageStart = performance.now();
      }
    };
    let digest: string, seconds: number;
    if (mode === "search") {
      const n = Number(input);
      if (!Number.isSafeInteger(n) || n < 1 || n > 1000000)
        throw new Error("Use 1–1000000 synthetic search records");
      const builder = new PagedSearchBuilder(
        `${work}/search-${workers}.sqlite`,
      );
      const hash = new Bun.CryptoHasher("sha256");
      try {
        for (let i = 0; i < n; i++)
          builder.addLocation({
            id: `node/${String(i).padStart(9, "0")}`,
            name: `${["High Street", "Station Road", "Queen's Park", "St Michael's Church", "Town Hall", "Railway Terrace", "King Edward Avenue"][i % 7]} ${i}`,
            aliases: [`Location ${i}`],
            context: `near ${["London", "Manchester", "Liverpool", "Bristol", "Edinburgh", "Glasgow"][i % 6]}`,
            coordinates: [
              -3 + (i % 1000) / 1000,
              52 + Math.floor(i / 1000) / 1000,
            ],
            kind: "poi",
            category: "landmark",
          });
        const start = performance.now();
        stageStart = start;
        await builder.finish(
          {
            add: async (b) => {
              hash.update(b.key);
              hash.update(b.bytes);
            },
          },
          { search: true, reverse: false, workers },
          undefined,
          progress,
        );
        seconds = (performance.now() - start) / 1000;
        digest = hash.digest("hex");
      } finally {
        await builder.dispose();
      }
    } else {
      const selection = {
        snapshot: "geofabrik",
        name: "Parallel parity fixture",
        polygon: [
          [9.471, 47.045],
          [9.638, 47.045],
          [9.638, 47.274],
          [9.471, 47.274],
        ],
        minZoom: 0,
        maxZoom: 16,
        layers: ["land", "water", "roads", "railways", "buildings", "peaks"],
        profiles: ["walking", "cycling", "driving"],
        featureKinds: ["water", "buildings", "roads", "railways", "land"],
        search: true,
        reverse: true,
        placeNames: true,
        streetNames: true,
        pois: true,
        peaks: true,
        paddingCells: 1,
        maxBytes: 500000000,
      } as any;
      const output = `${work}/fixture-${workers}.atlas`,
        start = performance.now();
      stageStart = start;
      await compilePartitioned({
        input,
        output,
        work: `${output}.work`,
        selection,
        workers,
        progress,
      });
      seconds = (performance.now() - start) / 1000;
      digest = await fileHash(output);
    }
    timings[stage] =
      (timings[stage] ?? 0) + (performance.now() - stageStart) / 1000;
    if (reference) assert.equal(digest, reference, "Parallel output changed!");
    reference = digest;
    console.log(JSON.stringify({ workers, seconds, sha256: digest, timings }));
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
