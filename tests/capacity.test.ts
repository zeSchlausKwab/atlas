import { test, expect } from "bun:test";
import {
  MIB,
  capacityBudget,
  preparationSpace,
  validBudget,
} from "../packages/provisioning/src/capacity";
import { readStorage } from "../apps/server/storage";
import { validateSourceArea } from "../packages/provisioning/src/global-source";
test("storage budgets support sizes above 2 GiB while rejecting missing, inexact and unsafe byte counts", () => {
  for (const bytes of [MIB, 4096 * MIB, 100 * 1024 * MIB])
    expect(validBudget(bytes)).toBe(true);
  for (const bytes of [
    0,
    -1,
    NaN,
    Infinity,
    undefined,
    "4096",
    MIB + 0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(validBudget(bytes)).toBe(false);
  expect(() =>
    validateSourceArea({
      polygon: [
        [16, 48],
        [16.1, 48],
        [16.1, 48.1],
        [16, 48.1],
      ],
      paddingCells: 1,
      profiles: [],
      maxSourceBytes: 50 * 1024 * MIB,
    }),
  ).not.toThrow();
});
test("workspace estimates account for source copies and output spooling without conflating the two budgets", () => {
  expect(preparationSpace(4096 * MIB)).toBe((8192 + 64) * MIB);
  expect(preparationSpace(4096 * MIB, 100 * MIB)).toBe(
    (4096 * 6 + 100 * 3 + 64) * MIB,
  );
  expect(preparationSpace(MIB, 100 * MIB)).toBe((64 * 6 + 300 + 64) * MIB);
  const free = 50 * 1024 * MIB;
  expect(
    preparationSpace(capacityBudget(free, "output", false)),
  ).toBeLessThanOrEqual(free);
  expect(capacityBudget(free, "source", true)).toBeGreaterThan(2 * 1024 * MIB);
  expect(capacityBudget(0, "output", false)).toBe(MIB);
});
test("free-space inspection reads the real filesystem and reports unavailable volumes as errors", async () => {
  const space = await readStorage("/tmp");
  expect(space.availableBytes).toBeGreaterThanOrEqual(0);
  expect(space.totalBytes).toBeGreaterThanOrEqual(space.availableBytes);
  expect(Number.isFinite(Date.parse(space.checkedAt))).toBe(true);
  await expect(
    readStorage(`/tmp/nonexistent-atlas-volume-${crypto.randomUUID()}`),
  ).rejects.toThrow();
});
