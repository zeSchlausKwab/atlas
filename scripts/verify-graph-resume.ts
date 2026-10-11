/** Kill the real native compiler at durable boundaries, then compare its entire stream. */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { join } from "node:path";
const root = await mkdtemp("/tmp/atlas-graph-resume-");
const input = process.argv[2] ?? "data/liechtenstein.osm.pbf";
const binary = "target/release/transport-partitioned";
async function run(
  work: string,
  stopStage?: string,
  minimum = 1,
  hash = "fixture-v1",
) {
  const child = Bun.spawn([binary, input, work], {
    env: {
      ...process.env,
      ATLAS_GRAPH_CHECKPOINT_BLOBS: "1",
      ATLAS_GRAPH_SOURCE_HASH: hash,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).arrayBuffer();
  let stopped = false,
    log = "";
  const stderr = child.stderr.getReader();
  while (true) {
    const { value: chunk, done } = await stderr.read();
    if (done) break;
    log += new TextDecoder().decode(chunk);
    const lines = log.split("\n");
    log = lines.pop()!;
    for (const line of lines)
      if (line.startsWith("ATLAS_PROGRESS ")) {
        const p = JSON.parse(line.slice(15));
        if (
          !stopped &&
          p.stage === stopStage &&
          p.completed >= minimum &&
          p.completed < p.total
        ) {
          stopped = true;
          child.kill("SIGKILL");
        }
      }
  }
  const code = await child.exited;
  const bytes = Buffer.from(await output);
  if (stopStage) assert(stopped, `never interrupted ${stopStage}`);
  else if (hash === "fixture-v1") assert.equal(code, 0, log);
  return { bytes, code };
}
try {
  const reference = (await run(join(root, "reference"))).bytes;
  const work = join(root, "resumed");
  for (const stage of [
    "routing-references",
    "routing-coordinates",
    "routing-walking",
    "routing-walking-cells",
    "routing-cycling",
    "routing-driving-cells",
  ]) {
    await run(work, stage);
    const db = new Database(join(work, "routing-v2.sqlite"), {
      readonly: true,
    });
    const state = JSON.parse(
      (db.query("SELECT state FROM checkpoint").get() as { state: string })
        .state,
    );
    db.close();
    assert(state.offset > 0);
    console.log(
      `Stopped ${stage}: cursor ${state.offset}, ${state.coordinates} coordinates, ${state.ids.join("/")} segments`,
    );
    if (stage === "routing-coordinates") {
      // Simulate writes after the last durable coordinate count: resume must truncate them.
      await appendFile(
        join(work, "routing-coordinates.bin"),
        Buffer.alloc(300),
      );
    }
  }
  assert.deepEqual((await run(work)).bytes, reference);
  assert.deepEqual(
    (await run(work)).bytes,
    reference,
    "completed cells must replay identically",
  );
  assert.notEqual((await run(work, undefined, 1, "changed-source")).code, 0);
  console.log(
    "PASS: six forced stops, partial coordinate rollback, complete-stream parity, completed-cell replay and changed-source rejection.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
