import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { CompilerObserver } from "../apps/server/compiler-observer";
import type { PreparationJob } from "../apps/server/preparations";
import { currentObservation } from "../packages/provisioning/src/compiler-observation";
import {
  ProgressRate,
  measuredProgress,
  compilerProgress,
} from "../packages/provisioning/src/compiler-progress";

test("ETA warms up on new work, then resets on stage changes, resume and stalls", () => {
  const rate = new ProgressRate();
  expect(rate.estimate("features", 50, 100, 0)).toBeUndefined();
  expect(rate.estimate("features", 55, 100, 5000)).toBeUndefined();
  expect(rate.estimate("features", 65, 100, 15000)).toBe(35);
  expect(rate.estimate("packing", 65, 100, 20000)).toBeUndefined();
  expect(rate.estimate("packing", 80, 100, 35000)).toBe(20);
  expect(rate.estimate("packing", 50, 100, 40000)).toBeUndefined();
  expect(rate.estimate("packing", 50, 100, 250000)).toBeUndefined();
  expect(rate.estimate("packing", 60, 0, 265000)).toBeUndefined();
});

test("a short pass reports its real start and completion even inside the throttle interval", () => {
  const values: string[] = [];
  const report = measuredProgress(
    (line) => values.push(line),
    "display",
    "Tiling",
    10,
    "objects",
    8,
  );
  report(10);
  expect(values.map((v) => compilerProgress(v)?.completed)).toEqual([8, 10]);
  expect(compilerProgress(values[0]!)?.etaSeconds).toBeUndefined();
});

test.each(["source.sqlite", "source-v3.sqlite", "source-v4.sqlite"])(
  "observation of %s counts sparse source rows and only augments a fresh running job",
  async (sourceKey) => {
    const directory = await mkdtemp("/tmp/atlas-progress-");
    const id = "f6b452bc-2f27-42da-a74f-e41ecc596c4a";
    const compiler = `${directory}/${id}.work/compiler`;
    await mkdir(compiler, { recursive: true });
    const source = new Database(`${compiler}/${sourceKey}`);
    source.run(
      "CREATE TABLE features(cell INTEGER); CREATE INDEX cells ON features(cell); INSERT INTO features(rowid,cell) VALUES(1,10),(3,10),(5,11),(7,11)",
    );
    source.close();
    const state = {
      completed: {
        "transport.atlas": { size: 100, sha256: "a" },
        [sourceKey]: { size: 200, sha256: "b" },
      },
    };
    await Bun.write(`${compiler}/partitioned.json`, JSON.stringify(state));
    const job = {
      id,
      name: "fixture",
      createdAt: "2026-10-11T06:00:00Z",
      state: "running",
      cachedSource: { id: "cached" },
      selection: {
        featureKinds: ["buildings"],
        profiles: ["walking"],
        search: true,
        layers: ["buildings"],
      },
      progress: {
        phase: "compiling",
        message: "Semantic source objects: 2",
        completed: 2,
        total: 0,
        unit: "stages",
        readBytes: 0,
        writtenBytes: 50,
      },
    } as PreparationJob;
    const before = await Bun.file(`${compiler}/${sourceKey}`).bytes();
    try {
      const observer = new CompilerObserver();
      const sample = (await observer.sample(job, directory))!;
      expect(sample.progress.completed).toBe(2);
      expect(sample.progress.total).toBe(4); // Not max(rowid) = 7.
      expect(sample.progress.stagePercent).toBe(50);
      expect(sample.progress.writtenBytes).toBe(350);
      expect(sample.stages.map((s) => s.state)).toEqual([
        "done",
        "done",
        "done",
        "active",
        "pending",
        "pending",
      ]);
      expect(await Bun.file(`${compiler}/${sourceKey}`).bytes()).toEqual(
        before,
      );
      expect(await Bun.file(`${compiler}/objects.sqlite`).exists()).toBe(false);
      const now = Date.parse(sample.observedAt);
      expect(currentObservation(sample, job, now)).toBe(sample);
      expect(
        currentObservation(sample, { ...job, id: "different" }, now),
      ).toBeUndefined();
      expect(
        currentObservation(sample, { ...job, createdAt: "new" }, now),
      ).toBeUndefined();
      expect(
        currentObservation(sample, { ...job, state: "ready" }, now),
      ).toBeUndefined();
      expect(currentObservation(sample, job, now + 46000)).toBeUndefined();
      expect(currentObservation(sample, job, now - 6000)).toBeUndefined();
      // Detect the end of the scan even if its last ordinary log was below the total.
      const spool = new Database(`${compiler}/objects.sqlite`);
      spool.run(
        "CREATE TABLE state(key TEXT,value TEXT); INSERT INTO state VALUES('cursor','4')",
      );
      spool.close();
      const finalizing = (await observer.sample(job, directory))!;
      expect(finalizing.progress.stage).toBe("semantic-finalization");
      expect(finalizing.progress.stagePercent).toBeUndefined();
      // Display resume uses the ordered cell+row cursor, not a feature ordinal.
      await Bun.write(
        `${compiler}/partitioned.json`,
        JSON.stringify({
          completed: {
            ...state.completed,
            "semantics.atlas": { size: 300, sha256: "c" },
          },
        }),
      );
      job.progress.message = `Display batch 1 saved (source cursor ${10 * 2 ** 32 + 3})`;
      expect(
        (await observer.sample(job, directory))?.progress.stagePercent,
      ).toBe(50);
      job.progress.message = `Display batch 2 saved (source cursor ${11 * 2 ** 32 + 5})`;
      expect(
        (await observer.sample(job, directory))?.progress.stagePercent,
      ).toBe(75);
      job.progress.message = `Display batch 3 saved (source cursor ${11 * 2 ** 32 + 7})`;
      expect(
        (await observer.sample(job, directory))?.progress.stagePercent,
      ).toBe(100);
      // A rollback invalidates incremental cursor counting.
      job.progress.message = `Display batch 1 saved (source cursor ${10 * 2 ** 32 + 3})`;
      expect(
        (await observer.sample(job, directory))?.progress.stagePercent,
      ).toBe(50);
      job.state = "ready";
      expect(await observer.sample(job, directory)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("live object packing exposes its committed total and checkpoint with NAS-assisted storage", async () => {
  const directory = await mkdtemp("/tmp/atlas-packing-progress-");
  const compiler = `${directory}/custom-local-work/compiler`;
  await mkdir(compiler, { recursive: true });
  const db = new Database(`${compiler}/source-v4.sqlite.objects-index.sqlite`);
  db.run(
    "CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES('a'),('b'),('c'),('d')",
  );
  db.close();
  await Bun.write(
    `${compiler}/partitioned.json`,
    JSON.stringify({
      completed: {
        "transport.atlas": { size: 100, sha256: "a" },
        "source-v4.sqlite": { size: 200, sha256: "b" },
      },
    }),
  );
  const job = {
    id: "fixture",
    createdAt: "2026-11-02T08:00:00Z",
    state: "running",
    cachedSource: { id: "pbf" },
    workspace: {
      work: `${directory}/custom-local-work`,
      artifacts: "/unmounted-nas/not-needed-for-progress",
    },
    selection: {
      profiles: ["walking"],
      layers: ["water"],
      featureKinds: ["objects"],
    },
    progress: {
      phase: "compiling",
      message: "Packing source objects · 2 objects",
      completed: 2,
      total: 0,
      unit: "stages",
      readBytes: 0,
      writtenBytes: 50,
    },
  } as PreparationJob;
  try {
    const before = await Bun.file(
      `${compiler}/source-v4.sqlite.objects-index.sqlite`,
    ).bytes();
    const observation = await new CompilerObserver().sample(job, directory);
    expect(observation?.progress.stage).toBe("semantic-object-packing");
    expect(observation?.progress.total).toBe(4);
    expect(observation?.progress.completed).toBe(2);
    expect(observation?.progress.stagePercent).toBe(50);
    expect(observation?.progress.etaSeconds).toBeUndefined();
    expect(observation?.progress.checkpointAt).toBeTruthy();
    expect(observation?.stages.map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
    expect(
      await Bun.file(
        `${compiler}/source-v4.sqlite.objects-index.sqlite`,
      ).bytes(),
    ).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
