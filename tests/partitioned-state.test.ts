import { expect, test } from "bun:test";
import {
  partitionedIdentity,
  reconcilePartitionedState,
} from "../packages/cli/src/partitioned-state";
import type { PackageSelection } from "../packages/provisioning/src/selection";
const selection: PackageSelection = {
  snapshot: "test",
  name: "Example",
  polygon: [
    [16, 48],
    [17, 48],
    [17, 49],
    [16, 49],
  ],
  minZoom: 0,
  maxZoom: 16,
  layers: ["water"],
  featureKinds: ["water"],
  profiles: ["cycling"],
  placeNames: true,
  streetNames: true,
  pois: true,
  search: true,
  reverse: true,
  peaks: false,
  paddingCells: 1,
  maxBytes: 1024 ** 3,
};
const hash = "a".repeat(64),
  receipt = { size: 123, sha256: "b".repeat(64) };
test("v4 resume retains compatible checkpoints and invalidates only semantic packing", () => {
  const old = {
    identity: partitionedIdentity(hash, selection, 4),
    completed: {
      "transport.atlas": receipt,
      "source.sqlite": receipt,
      "display.atlas": receipt,
      "semantics.atlas": receipt,
      "unknown-stage": receipt,
    },
  };
  const result = reconcilePartitionedState(old, hash, selection);
  expect(result.migrated).toBe(true);
  expect(result.state.identity).toBe(partitionedIdentity(hash, selection));
  expect(Object.keys(result.state.completed)).toEqual([
    "transport.atlas",
    "source.sqlite",
    "display.atlas",
  ]);
  expect(result.state.completed["source.sqlite"]).toEqual(receipt);
  expect(old.completed["semantics.atlas"]).toEqual(receipt);
  expect(
    reconcilePartitionedState(result.state, hash, selection).migrated,
  ).toBe(false);
});
test("migration refuses changed input, selection or unsupported compiler versions", () => {
  const old = {
    identity: partitionedIdentity(hash, selection, 4),
    completed: { "source.sqlite": receipt },
  };
  for (const candidate of [
    () => reconcilePartitionedState(old, "c".repeat(64), selection),
    () => reconcilePartitionedState(old, hash, { ...selection, search: false }),
    () =>
      reconcilePartitionedState(
        { ...old, identity: partitionedIdentity(hash, selection, 3) },
        hash,
        selection,
      ),
  ])
    expect(candidate).toThrow("another source, recipe or compiler");
  expect(
    reconcilePartitionedState(undefined, hash, selection).state.completed,
  ).toEqual({});
});
