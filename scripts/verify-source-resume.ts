/** Exercise the real source importer, including forced termination and coordinate rollback. */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
const root = await mkdtemp("/tmp/atlas-source-resume-");
const input = process.argv[2] ?? "data/liechtenstein.osm.pbf";
async function run(
  path: string,
  stopStage?: string,
  hash = "fixture-v1",
  minimum = 1,
) {
  const p = Bun.spawn(["target/release/source-store", input, path], {
    env: {
      ...process.env,
      ATLAS_SOURCE_CHECKPOINT_BLOBS: "1",
      ATLAS_SOURCE_HASH: hash,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let stopped = false,
    buffer = "",
    log = "";
  const reader = p.stderr.getReader();
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    const text = new TextDecoder().decode(chunk);
    buffer += text;
    log += text;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("ATLAS_PROGRESS ")) continue;
      const progress = JSON.parse(line.slice(15));
      if (
        !stopped &&
        progress.stage === stopStage &&
        progress.completed >= minimum &&
        (!progress.total || progress.completed < progress.total)
      ) {
        stopped = true;
        p.kill("SIGKILL");
      }
    }
  }
  const code = await p.exited;
  if (stopStage) assert(stopped, `Never stopped ${stopStage}\n${log}`);
  else if (hash === "fixture-v1") assert.equal(code, 0, log);
  return { code, log };
}
function snapshot(path: string) {
  // Read-write open lets SQLite recover a hot journal after a forced stop.
  const db = new Database(path);
  assert.deepEqual(db.query("PRAGMA quick_check").all(), [
    { quick_check: "ok" },
  ]);
  const tables = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type='table' AND name<>'source_checkpoint' ORDER BY name")
    .all();
  const digest = createHash("sha256");
  for (const { name } of tables) {
    digest.update(name);
    for (const row of db.query(`SELECT * FROM "${name}" ORDER BY 1`).iterate())
      digest.update(JSON.stringify(row));
  }
  db.close();
  return digest.digest("hex");
}
try {
  const baseline = root + "/baseline.sqlite",
    resumed = root + "/resumed.sqlite";
  await run(baseline);
  const expected = snapshot(baseline);
  for (const stage of [
    "source-references",
    "source-ways",
    "source-areas",
    "source-finalization",
    "source-validation",
  ]) {
    await run(
      resumed,
      stage,
      "fixture-v1",
      stage === "source-validation" ? 0 : 1,
    );
    const db = new Database(resumed);
    assert.deepEqual(db.query("PRAGMA quick_check").all(), [
      { quick_check: "ok" },
    ]);
    const state = JSON.parse(
      (
        db.query("SELECT state FROM source_checkpoint").get() as {
          state: string;
        }
      ).state,
    );
    db.close();
    console.log(
      `Stopped ${stage}: stage ${state.stage}, byte cursor ${state.offset}, ways ${state.ways}`,
    );
    if (stage === "source-references")
      await appendFile(resumed + ".coordinates", Buffer.alloc(300));
  }
  await run(resumed);
  assert.equal(
    snapshot(resumed),
    expected,
    "resumed source tables must match uninterrupted construction",
  );
  await run(resumed);
  assert.equal(
    snapshot(resumed),
    expected,
    "completed-stage replay must not recreate temporary tables",
  );
  const changed = await run(resumed, undefined, "different-source");
  assert.notEqual(changed.code, 0);
  assert.match(changed.log, /another source or compiler/);
  assert.equal(snapshot(resumed), expected);
  console.log(
    "PASS: five forced stops, durable rollback, coordinate truncation, semantic parity, completed replay and changed-source rejection.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
