import { test, expect } from "bun:test";
import { parallelMap } from "../packages/compiler/src/process-pool";
import { compilerWorkers } from "../packages/compiler/src/settings";
const worker = new URL("./fixtures/compiler-pool-worker.ts", import.meta.url);

test("worker budget validates explicit settings", () => {
  expect(compilerWorkers(6)).toBe(6);
  expect(compilerWorkers("1")).toBe(1);
  for (const value of [0, 9, 1.5, "all", "", null])
    expect(() => compilerWorkers(value)).toThrow();
});
test("pool runs concurrently, bounds queued inputs and yields in source order", async () => {
  let produced = 0;
  const pids = new Set<number>();
  function* inputs() {
    for (let id = 0; id < 8; id++) {
      produced++;
      yield { id, delay: id === 0 ? 100 : 5 };
    }
  }
  const results: number[] = [];
  for await (const { result } of parallelMap<any, number>(
    worker,
    inputs(),
    3,
    undefined,
    (_i, v) => pids.add(v.pid),
  )) {
    expect(produced - results.length).toBeLessThanOrEqual(3);
    results.push(result);
  }
  expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(pids.size).toBeGreaterThan(1);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
});
test("cancellation and worker errors terminate all children before returning", async () => {
  for (const mode of ["cancel", "fail", "crash"]) {
    const abort = new AbortController(),
      pids = new Set<number>();
    const consume = async () => {
      for await (const _ of parallelMap(
        worker,
        [
          {
            id: 0,
            delay: mode === "cancel" ? 60000 : 100,
            fail: mode === "fail",
            crash: mode === "crash",
          },
          { id: 1, delay: 60000 },
        ],
        2,
        abort.signal,
        (_i, value) => {
          pids.add(value.pid);
          if (mode === "cancel" && pids.size === 2)
            abort.abort(new Error("test cancellation"));
        },
      )) {
      }
    };
    await expect(consume()).rejects.toThrow();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }
}, 10000);
