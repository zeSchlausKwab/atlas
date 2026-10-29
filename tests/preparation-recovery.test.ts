import { test, expect } from "bun:test";
import {
  recoverBuild,
  retryableFailure,
} from "../apps/server/preparation-recovery";
import { Preparations, type PreparationJob } from "../apps/server/preparations";
import { pluginFixture } from "./helpers/plugin-fixture";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
const job = () =>
  ({
    state: "running",
    progress: {
      stage: "routing-cycling",
      checkpointAt: "2026-10-29T01:00:00Z",
    },
  }) as PreparationJob;
test("native crashes retry with persistent backoff and preserve checkpoint diagnostics", () => {
  const j = job(),
    now = 1_000_000;
  expect(
    recoverBuild(
      j,
      "failed (null): free(): double free detected in tcache 2",
      now,
    ),
  ).toBe(true);
  expect(j.state).toBe("queued");
  expect(j.recovery!.nextAttemptAt).toBe(new Date(now + 60_000).toISOString());
  const restored = JSON.parse(JSON.stringify(j));
  expect(recoverBuild(restored, "SIGABRT", now)).toBe(true);
  expect(restored.recovery.nextAttemptAt).toBe(
    new Date(now + 300_000).toISOString(),
  );
  expect(recoverBuild(restored, "SIGSEGV", now)).toBe(true);
  expect(recoverBuild(restored, "SIGABRT", now)).toBe(false);
  expect(restored.state).toBe("failed");
  expect(restored.recovery.history).toHaveLength(4);
  expect(restored.recovery.history[0].checkpointAt).toBe(
    j.progress.checkpointAt,
  );
});
test("disk guards, corrupt data and deterministic validation errors require attention", () => {
  for (const e of [
    "Preparation stopped to preserve 10 GiB free",
    "ENOSPC",
    "database disk image is malformed",
    "checksum mismatch",
    "Tile exceeds its point limit",
    "Source snapshot changed",
    "Permission denied",
    "Unknown error",
  ]) {
    expect(retryableFailure(e)).toBe(false);
    expect(recoverBuild(job(), e)).toBe(false);
  }
  expect(retryableFailure("Server interrupted an active preparation")).toBe(
    true,
  );
});
test("interrupted host restores a delayed retry, but deliberate cancellation stays stopped", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-recovery-");
  await mkdir(dir + "/hosted");
  const id = crypto.randomUUID(),
    stopped = crypto.randomUUID();
  const record = {
    id,
    name: "Recovery fixture",
    createdAt: new Date().toISOString(),
    selection: {},
    ...job(),
  };
  await Bun.write(dir + "/hosted/" + id + ".json", JSON.stringify(record));
  await Bun.write(
    dir + "/hosted/" + stopped + ".json",
    JSON.stringify({ ...record, id: stopped, state: "cancelling" }),
  );
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  try {
    expect(manager.jobs.get(id)!.state).toBe("queued");
    expect(manager.jobs.get(stopped)!.state).toBe("cancelled");
    await manager.startQueue();
    expect(manager.jobs.get(id)!.state).toBe("queued");
    await manager.cancel(id);
    expect(manager.jobs.get(id)!.state).toBe("cancelled");
    expect(manager.jobs.get(id)!.recovery!.nextAttemptAt).toBeUndefined();
    const saved = await Bun.file(dir + "/hosted/" + id + ".json").json();
    expect(saved.recovery.history).toHaveLength(1);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
