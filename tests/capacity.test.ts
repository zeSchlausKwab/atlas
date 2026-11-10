import { test, expect } from "bun:test";
import {
  MIB,
  DISK_RESERVE,
  BUILD_DISK_FLOOR,
  cachedResumeSpace,
  cachedBuildSpace,
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

test("saved partitioned builds restart with headroom instead of reserving the entire output ceiling again", () => {
  const gib = 1024 ** 3;
  expect(DISK_RESERVE).toBe(10 * gib);
  expect(BUILD_DISK_FLOOR).toBe(12 * gib);
  expect(cachedResumeSpace(128 * gib, true, 40 * gib)).toBe(76 * gib);
  // The observed Europe case has 97 GiB free: enough to restart, not a promise to finish.
  expect(cachedResumeSpace(128 * gib, true, 40 * gib)).toBeLessThan(97 * gib);
  expect(cachedBuildSpace(128 * gib, true)).toBeGreaterThan(97 * gib);
  expect(cachedResumeSpace(gib, true, 40 * gib)).toBe(13 * gib);
  // Missing extraction and the legacy regional compiler retain their full admission checks.
  expect(cachedResumeSpace(128 * gib, true, 0)).toBe(
    cachedBuildSpace(128 * gib, true),
  );
  expect(cachedResumeSpace(gib, false, 40 * gib)).toBe(cachedBuildSpace(gib));
});

test("uncapped host estimates stay finite and storage overrides bypass only admission", async () => {
  const {
    NO_SIZE_LIMIT,
    hostPreparationSpace,
    checkStorageEstimate,
    StorageWarning,
  } = await import("../packages/provisioning/src/capacity");
  expect(hostPreparationSpace(NO_SIZE_LIMIT, { atlasBytes: 20 * MIB })).toBe(
    104 * MIB,
  );
  expect(
    hostPreparationSpace(NO_SIZE_LIMIT, { sourceBytes: 407 * MIB }),
  ).toBeLessThan(20 * 1024 ** 3);
  expect(
    hostPreparationSpace(NO_SIZE_LIMIT, { cached: true, partitioned: true }),
  ).toBe(76 * 1024 ** 3);
  expect(() => checkStorageEstimate(200, 100)).toThrow(StorageWarning);
  expect(() => checkStorageEstimate(200, 100, true)).not.toThrow();
  expect(() => checkStorageEstimate(200, 100, "true")).toThrow(
    "Invalid storage override",
  );
  expect(BUILD_DISK_FLOOR).toBe(12 * 1024 ** 3);
});
