/** Differential check: external-memory construction must preserve every RCL2 byte. */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { addPartitionedTransport } from "../packages/cli/src/transport-partitioned";
import { runCompiler } from "../packages/provisioning/src/process";
const work = await mkdtemp("/tmp/atlas-graph-parity-");
const input = process.argv[2] ?? "data/liechtenstein.osm.pbf";
const signal = new AbortController().signal;
const run = (args: string[]) =>
  runCompiler(args, process.cwd(), signal, console.log);
try {
  await run([
    "cargo",
    "build",
    "--release",
    "-p",
    "atlas-osm-import",
    "-p",
    "atlas-routing",
    "--bins",
  ]);
  await run([
    "target/release/transport-import",
    input,
    join(work, "reference"),
  ]);
  let expected = 0;
  for (const mode of ["walking", "cycling", "driving"]) {
    await run([
      "target/release/partition-routing",
      join(work, "reference", `${mode}.rte`),
      join(work, mode),
    ]);
    expected += (await readdir(join(work, mode))).length;
  }
  let checked = 0;
  const stats = await addPartitionedTransport(
    {
      async add(block) {
        const p = block.key.split("/");
        const reference = new Uint8Array(
          await Bun.file(
            join(work, p[1]!, `${p[4]}-${p[5]}.rcl`),
          ).arrayBuffer(),
        );
        assert.deepEqual(block.bytes, reference, `Cell differs: ${block.key}`);
        checked++;
      },
    },
    input,
    work,
  );
  assert.equal(checked, expected);
  console.log(JSON.stringify({ input, checked, stats }));
  console.log(
    "PASS: every routing cell matches the reference compiler byte-for-byte in all three profiles.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
