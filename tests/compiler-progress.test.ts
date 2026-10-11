import { test, expect } from "bun:test";
import {
  compilerProgress,
  approximateDuration,
} from "../packages/provisioning/src/compiler-progress";
import { cachedBuildSpace } from "../packages/provisioning/src/capacity";
const line = (v: object) =>
  "ATLAS_PROGRESS " +
  JSON.stringify({
    stage: "routing-walking",
    message: "Walking",
    completed: 25,
    total: 100,
    unit: "ways",
    ...v,
  });
test("stage progress preserves measured ETA and does not invent one during warmup", () => {
  expect(compilerProgress(line({ etaSeconds: 90 }))?.etaSeconds).toBe(90);
  expect(
    compilerProgress(line({ etaSeconds: null }))?.etaSeconds,
  ).toBeUndefined();
  expect(
    compilerProgress(line({ etaSeconds: -1 }))?.etaSeconds,
  ).toBeUndefined();
  expect(compilerProgress(line({}))?.stagePercent).toBe(25);
  expect(compilerProgress(line({ completed: 101 }))).toBeUndefined();
  expect(compilerProgress("ATLAS_PROGRESS broken")).toBeUndefined();
  expect(compilerProgress("ordinary output")).toBeUndefined();
  expect(approximateDuration(90)).toBe("2 min");
});
test("resume credits existing scratch without reducing disk reserve or output allowance", () => {
  const gib = 1024 ** 3;
  expect(cachedBuildSpace(128 * gib, true)).toBe(252 * gib);
  expect(cachedBuildSpace(128 * gib, true, 40 * gib)).toBe(212 * gib);
  expect(cachedBuildSpace(128 * gib, true, 100 * gib)).toBe(188 * gib);
});

test("semantic and packaging counters use measurable units", () => {
  for (const unit of [
    "objects",
    "records",
    "terms",
    "blocks",
    "bytes",
    "cells",
  ])
    expect(compilerProgress(line({ unit }))?.stagePercent).toBe(25);
  expect(compilerProgress(line({ unit: "guesses" }))).toBeUndefined();
  expect(
    compilerProgress(line({ completed: 0, total: 0 }))?.stagePercent,
  ).toBeUndefined();
});
