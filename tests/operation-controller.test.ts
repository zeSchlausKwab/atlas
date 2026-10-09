import { expect, test } from "bun:test";
import { OperationController } from "../packages/operations/src/controller";
import type { RoutingProgress } from "../packages/routing/src/paged";
import type { OperationInputs } from "../packages/operations/src/contract";
const progress: RoutingProgress = {
  phase: "searching",
  cells: [],
  fetchedBytes: 0,
  reusedCells: 0,
  loadedCells: 0,
  residentCells: 0,
  memoryBytes: 0,
  computeMs: 0,
  visited: 1,
};
const input: OperationInputs["route"] = {
  start: [16, 48],
  end: [16.01, 48],
  profile: "walking",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
test("transport supersession suppresses stale results/progress, while cancellation belongs to its tool", async () => {
  const c = new OperationController(),
    old = deferred<string>(),
    fresh = deferred<string>();
  const events: string[] = [];
  let staleProgress!: (p: RoutingProgress) => void;
  c.subscribe((e) => events.push(e.operation));
  const route = c.run("route", input, async (_, signal, p) => {
    staleProgress = p;
    return old.promise;
  });
  const caught = route.catch((e) => e.name);
  await Promise.resolve();
  const iso = c.run(
    "isochrone",
    { start: [16, 48], bands: [300], profile: "cycling" },
    async (_, signal, p) => {
      p(progress);
      return fresh.promise;
    },
  );
  await Promise.resolve();
  c.cancel("route");
  staleProgress(progress);
  fresh.resolve("new contours");
  old.resolve("stale route");
  expect(await caught).toBe("AbortError");
  expect(await iso).toBe("new contours");
  expect(events).toEqual(["isochrone"]);
});
test("requests capture their input before controls can mutate it; subscriptions can detach", async () => {
  const c = new OperationController(),
    request: OperationInputs["route"] = structuredClone(input);
  let count = 0;
  const unsubscribe = c.subscribe(() => count++);
  const work = c.run("route", request, async (p, signal, progressFn) => {
    progressFn(progress);
    return p;
  });
  request.start[0] = 0;
  request.profile = "driving";
  expect(await work).toEqual(input);
  expect(count).toBe(1);
  unsubscribe();
  await c.run("route", input, async (_, signal, p) => {
    p(progress);
  });
  expect(count).toBe(1);
});
test("cancel rejects immediately even if a local read is pending, without cancelling other operation channels", async () => {
  const c = new OperationController(),
    pending = deferred<void>();
  let aborted = false;
  const route = c.run("route", input, async (_, signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    await pending.promise;
  });
  const rejection = route.catch((e) => e.name);
  await Promise.resolve();
  const search = c.run("search", { query: "Vienna" }, async (p) => p.query);
  c.cancel("route");
  expect(await rejection).toBe("AbortError");
  expect(aborted).toBe(true);
  expect(await search).toBe("Vienna");
  pending.resolve();
});
