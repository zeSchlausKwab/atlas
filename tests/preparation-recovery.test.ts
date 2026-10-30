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
    ...job(),
    id,
    name: "Recovery fixture",
    createdAt: new Date().toISOString(),
    selection: {} as PreparationJob["selection"],
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

test("a persisted retry wakes the queue and completes without a browser or manual resume", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-retry-dispatch-");
  await mkdir(dir + "/hosted");
  const sourceId = crypto.randomUUID(),
    retryId = crypto.randomUUID(),
    manifest = f.reader.index.manifest;
  await Bun.write(dir + "/source.atlas", f.bytes);
  await Bun.write(dir + "/hosted/" + sourceId + ".atlas", f.bytes);
  const selection = {
    name: "Recovered export",
    snapshot: manifest.snapshot,
    polygon: [
      [9, 47],
      [9.2, 47],
      [9.2, 47.2],
      [9, 47.2],
    ],
    minZoom: 0,
    maxZoom: 0,
    layers: [],
    profiles: [],
    featureKinds: [],
    placeNames: false,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    paddingCells: 0,
    maxBytes: 1048576,
  };
  const record = {
    id: sourceId,
    name: "Source",
    createdAt: new Date().toISOString(),
    state: "ready",
    selection,
    manifest,
    size: f.bytes.length,
    progress: {
      phase: "packing",
      message: "ready",
      completed: 1,
      total: 1,
      readBytes: 0,
      writtenBytes: f.bytes.length,
    },
  };
  await Bun.write(
    dir + "/hosted/" + sourceId + ".json",
    JSON.stringify(record),
  );
  await Bun.write(
    dir + "/hosted/" + retryId + ".json",
    JSON.stringify({
      ...record,
      id: retryId,
      name: "Recovered export",
      state: "queued",
      manifest: undefined,
      size: undefined,
      allowStorageRisk: true,
      resumeCheckpoint: true,
      compositionExport: {
        name: "Recovered export",
        inputs: [{ id: sourceId, snapshot: manifest.snapshot }],
      },
      recovery: {
        retries: 1,
        nextAttemptAt: new Date(Date.now() + 150).toISOString(),
        history: [
          {
            at: new Date().toISOString(),
            error: "Server interrupted an active preparation",
            action: "Retry from checkpoints",
          },
        ],
      },
    }),
  );
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    manifest,
  );
  try {
    const j = manager.jobs.get(retryId)!;
    await manager.startQueue();
    expect(j.state).toBe("queued");
    const deadline = Date.now() + 10000;
    while (!["ready", "failed"].includes(j.state) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(j.error).toBeUndefined();
    expect(j.state).toBe("ready");
    expect(j.recovery?.retries).toBe(1);
    expect(j.recovery?.nextAttemptAt).toBeUndefined();
    expect(j.recovery?.history).toHaveLength(1);
    const persisted = await Bun.file(
      dir + "/hosted/" + retryId + ".json",
    ).json();
    expect(persisted.state).toBe("ready");
  } finally {
    await manager.close();
    f.engine.destroy();
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual resume keeps checkpoint recipes byte-identical when storage consent changes", async () => {
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-manual-resume-");
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  manager.startQueue = async () => {};
  try {
    const selection: PreparationJob["selection"] = {
      name: "Resume recipe",
      snapshot: f.reader.index.manifest.snapshot,
      polygon: [
        [9, 47],
        [9.2, 47],
        [9.2, 47.2],
        [9, 47.2],
      ],
      minZoom: 0,
      maxZoom: 0,
      layers: [],
      profiles: [],
      featureKinds: ["water"],
      placeNames: false,
      streetNames: false,
      pois: false,
      search: false,
      reverse: false,
      peaks: false,
      paddingCells: 0,
      maxBytes: 1048576,
    };
    for (const legacyFlag of [undefined, true, false]) {
      const original =
        legacyFlag === undefined
          ? selection
          : { ...selection, allowStorageRisk: legacyFlag };
      const recipe = JSON.stringify(original);
      const created = await manager.create(original);
      for (const consent of [true, false]) {
        created.state = "cancelled";
        manager.jobs.set(created.id, created);
        const resumed = await manager.resume(created.id, consent);
        expect(JSON.stringify(resumed.selection)).toBe(recipe);
        expect(resumed.allowStorageRisk).toBe(consent);
        const saved = await Bun.file(
          dir + "/hosted/" + created.id + ".json",
        ).json();
        expect(JSON.stringify(saved.selection)).toBe(recipe);
        expect(saved.allowStorageRisk).toBe(consent);
      }
    }
  } finally {
    await manager.close();
    f.engine.destroy();
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
