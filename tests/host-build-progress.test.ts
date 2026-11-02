import { expect, test } from "bun:test";
import type { PreparationJob } from "../apps/server/preparations";
import {
  buildProgressModel,
  orderBuildJobs,
} from "../apps/host/src/host-build-progress";
const job = (): PreparationJob =>
  ({
    id: "fixture",
    name: "Map",
    createdAt: "2026-11-02T08:00:00Z",
    state: "running",
    cachedSource: { id: "source" },
    selection: {
      profiles: ["walking"],
      layers: ["water"],
      featureKinds: ["objects"],
      search: true,
    },
    progress: {
      phase: "compiling",
      message: "Packing source objects · 21400000 objects",
      completed: 2,
      total: 0,
      unit: "stages",
      readBytes: 0,
      writtenBytes: 1600 * 1024 ** 2,
    },
  }) as PreparationJob;
test("text-only worker still gets a stage timeline and real counter, without a fabricated ETA", () => {
  const m = buildProgressModel(job());
  expect(m.step).toBe("Step 4 of 6");
  expect(m.stages.map((s) => s.state)).toEqual([
    "done",
    "done",
    "done",
    "active",
    "pending",
    "pending",
  ]);
  expect(m.counter).toBe(
    `${(21400000).toLocaleString()} / ? objects processed`,
  );
  expect(m.percent).toBeUndefined();
  expect(m.eta).toBeUndefined();
  expect(m.elapsed).toBeUndefined();
});
test("measured progress includes zero percent, pass timing and saved checkpoint", () => {
  const j = job();
  j.progress = {
    ...j.progress,
    stage: "routing-walking",
    message: "Walking graph",
    completed: 0,
    total: 100,
    unit: "cells",
    stagePercent: 0,
    etaSeconds: 90,
    elapsedSeconds: 300,
    checkpointAt: "2026-11-02T09:00:00Z",
    stageIndex: 4,
    stageCount: 8,
  };
  const m = buildProgressModel(j);
  expect(m.percent).toBe(0);
  expect(m.eta).toBe("2 min");
  expect(m.elapsed).toBe("5 min");
  expect(m.checkpoint).toBeTruthy();
  expect(m.substep).toBe("Routing pass 4 of 8");
  expect(m.step).toBe("Step 2 of 6");
});
test("native timing and checkpoint do not depend on a stage-name field or observer", () => {
  const j = job();
  j.progress = {
    ...j.progress,
    message: "Working",
    completed: 4,
    total: 10,
    unit: "blocks",
    elapsedSeconds: 120,
    etaSeconds: 180,
    checkpointAt: "2026-11-02T09:00:00Z",
  };
  const m = buildProgressModel(j);
  expect(m.percent).toBe(40);
  expect(m.elapsed).toBe("2 min");
  expect(m.eta).toBe("3 min");
  expect(m.stages.every((s) => s.state === "pending")).toBe(true);
});
test("queue is FIFO below active and attention jobs; published library order is stable", () => {
  const rows = [
    { state: "queued", createdAt: "3" },
    { state: "ready", createdAt: "4" },
    { state: "queued", createdAt: "2" },
    { state: "running", createdAt: "1" },
    { state: "ready", createdAt: "0" },
    { state: "failed", createdAt: "5" },
  ] as PreparationJob[];
  expect(orderBuildJobs(rows).map((j) => j.createdAt)).toEqual([
    "1",
    "5",
    "2",
    "3",
    "4",
    "0",
  ]);
  expect(rows[0].createdAt).toBe("3");
});
test("import jobs do not get a fictitious PBF pipeline; disabled capabilities are omitted", () => {
  const j = job();
  j.cachedSource = undefined;
  expect(buildProgressModel(j).stages).toEqual([]);
  j.cachedSource = { id: "source" } as any;
  j.selection.profiles = [];
  j.selection.featureKinds = [];
  j.selection.search = false;
  j.progress.message = "Generating display tiles";
  expect(buildProgressModel(j).stages.map((s) => s.label)).toEqual([
    "PBF extraction",
    "Source geometry",
    "Display tiles",
    "Assembly & verification",
  ]);
});

test("previous n/x remain visible while the current pass has no measurement", () => {
  const j = job();
  j.progress = {
    ...j.progress,
    stage: "semantic-object-tags",
    message: "Building exact tag-value index",
    completed: 0,
    total: 0,
    unit: undefined,
  };
  const m = buildProgressModel(j, undefined, [
    {
      stage: "packing",
      message: "Packing source objects",
      completed: 1000,
      total: 1000,
      unit: "objects",
    },
    {
      stage: "lookup",
      message: "Indexing source identities",
      completed: 900,
      total: 1000,
      unit: "objects",
    },
  ]);
  expect(m.counter).toBeUndefined();
  expect(m.percent).toBeUndefined();
  expect(m.eta).toBeUndefined();
  expect(m.previousPasses).toEqual([
    {
      label: "Packing source objects",
      counter: `${(1000).toLocaleString()} / ${(1000).toLocaleString()} objects`,
      status: "Complete",
    },
    {
      label: "Indexing source identities",
      counter: `900 / ${(1000).toLocaleString()} objects`,
      status: "Last reported",
    },
  ]);
});
