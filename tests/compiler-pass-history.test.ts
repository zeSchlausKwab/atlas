import { expect, test } from "bun:test";
import { CompilerPassHistory } from "../packages/provisioning/src/compiler-pass-history";
const pass = (stage: string, completed = 4, total = 10) => ({
  stage,
  message: stage,
  completed,
  total,
  unit: "objects" as const,
});
test("a new uncounted pass retains earlier measured n/x without claiming completion", () => {
  const history = new CompilerPassHistory();
  history.record(pass("packing", 8));
  history.record(pass("tags", 0, 0));
  expect(history.previous("tags")).toEqual([pass("packing", 8)]);
  expect(history.previous("packing")).toEqual([]);
});
test("retry counter regression invalidates later measurements", () => {
  const history = new CompilerPassHistory();
  history.record(pass("source", 10));
  history.record(pass("packing", 10));
  history.record(pass("tags", 8));
  history.record(pass("packing", 2));
  expect(history.previous("packing")).toEqual([pass("source", 10)]);
});
test("zero-of-known-total and unknown totals are kept; parent-stage counters are not item counts", () => {
  const history = new CompilerPassHistory();
  history.record(pass("source", 0));
  history.record(pass("tags", 8, 0));
  history.record({ ...pass("parent"), unit: "stages" });
  history.record(pass("invalid", 11, 10));
  expect(history.previous()).toEqual([pass("source", 0), pass("tags", 8, 0)]);
  const rows = history.previous();
  rows[0]!.completed = 1000;
  expect(history.previous()[0]!.completed).toBe(0);
});
