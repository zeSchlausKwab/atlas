/** Verify the exercise against actual local archives. No model or online geocoding required. */
import assert from "node:assert/strict";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
import { RoutingComposition } from "../packages/routing/src/composition";
import type { RouteResult } from "../packages/routing/src/index";
import { PagedRouter } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
import manifest from "../examples/delivery/vienna-day.json";
const paths = process.argv.slice(2);
if (!paths.length)
  paths.push(
    "data/pair-rehearsal/west-paged.atlas",
    "data/pair-rehearsal/east-paged.atlas",
  );
const readers: AtlasReader[] = [];
let runtime: ChatDataRuntime | undefined, router: PagedRouter | undefined;
const minute = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
};
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
try {
  for (const path of paths)
    readers.push(await new AtlasReader(new FileSource(Bun.file(path))).open());
  runtime = new ChatDataRuntime(readers);
  const resolved = new Map<string, any>();
  for (const stop of [manifest.depot, ...manifest.deliveries]) {
    const a = stop.address,
      query = `${a.street} ${a.houseNumber} ${a.postcode}`;
    const found = await runtime.invoke(
      "search",
      { query, limit: 20 },
      new AbortController().signal,
    );
    const exact = found.matches.filter(
      (r: any) =>
        r.kind === "address" &&
        r.address?.street === a.street &&
        r.address?.houseNumber === a.houseNumber &&
        r.address?.postcode === a.postcode,
    );
    assert.equal(found.truncated, false, `Truncated search: ${query}`);
    assert.equal(
      exact.length,
      1,
      `Expected one explicit address anchor: ${query}`,
    );
    resolved.set(stop.id, exact[0]);
  }
  assert(
    manifest.deliveries.reduce((n, d) => n + d.weightKg, 0) <=
      manifest.vehicle.capacityKg,
  );
  assert(
    manifest.deliveries.reduce((n, d) => n + d.packages, 0) <=
      manifest.vehicle.capacityPackages,
  );
  initSync({
    module: await Bun.file(
      "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
    ).arrayBuffer(),
  });
  const composition = new RoutingComposition(
    readers.map((reader, i) => ({ id: String(i), reader })),
  );
  router = new PagedRouter(
    composition.snapshot,
    (k) => composition.read(k),
    () => {},
    async () => {},
    { searchStates: 2_000_000 },
  );
  // A reference feasible tour, not an optimization benchmark or expected AI ordering.
  const order = [
    "DEPOT",
    ...Array.from(
      { length: 12 },
      (_, i) => `D${String(i + 1).padStart(2, "0")}`,
    ),
    "DEPOT",
  ];
  let now = minute(manifest.shift.start),
    meters = 0,
    travelMinutes = 0,
    waitingMinutes = 0,
    breakTaken = false;
  const schedule: any[] = [];
  for (let i = 1; i < order.length; i++) {
    const from = order[i - 1]!,
      to = order[i]!;
    const route: RouteResult = await router.route(
      resolved.get(from).coordinates,
      resolved.get(to).coordinates,
      "cycling",
      composition.prefix("cycling"),
    );
    assert.equal(route.status, "found", `${from} → ${to}`);
    assert(typeof route.seconds === "number" && Number.isFinite(route.seconds));
    const travel = Math.ceil(route.seconds / 60);
    now += travel;
    meters += route.meters;
    travelMinutes += travel;
    const arrival = now;
    const stop = manifest.deliveries.find((d) => d.id === to);
    if (!stop) {
      schedule.push({
        from,
        to,
        meters: route.meters,
        travelMinutes: travel,
        arrival: time(now),
      });
      continue;
    }
    let earliest = Math.max(now, minute(stop.timeWindow.start));
    if (!breakTaken && earliest >= minute(manifest.break.startNotBefore)) {
      const start = Math.max(now, minute(manifest.break.startNotBefore));
      assert(
        start + manifest.break.durationMinutes <=
          minute(manifest.break.finishNotAfter),
      );
      waitingMinutes += start - now;
      now = start + manifest.break.durationMinutes;
      breakTaken = true;
      schedule.push({
        kind: "break",
        at: to,
        start: time(start),
        end: time(now),
      });
      earliest = Math.max(now, minute(stop.timeWindow.start));
    }
    waitingMinutes += earliest - now;
    now = earliest + stop.serviceMinutes;
    assert(now <= minute(stop.timeWindow.end), `Missed window: ${to}`);
    schedule.push({
      from,
      to,
      meters: route.meters,
      travelMinutes: travel,
      arrival: time(arrival),
      serviceStart: time(earliest),
      serviceEnd: time(now),
    });
  }
  assert(breakTaken);
  assert(now <= minute(manifest.shift.end));
  assert.equal(
    new Set([...composition.served.values()].map((s) => s.source)).size,
    2,
    "Tour must use both maps",
  );
  console.log(
    JSON.stringify(
      {
        schema: "atlas-delivery-verification-v1",
        verifiedAt: new Date().toISOString(),
        scope:
          "One feasible tour, not an optimum. Static cycling estimates; minutes rounded up per leg.",
        maps: readers.map((r) => ({
          name: r.index.manifest.name,
          snapshot: r.index.manifest.snapshot,
          capabilities: r.index.manifest.capabilities,
        })),
        addresses: Object.fromEntries(resolved),
        order,
        schedule,
        totals: {
          meters,
          travelMinutes,
          serviceMinutes: manifest.deliveries.reduce(
            (n, d) => n + d.serviceMinutes,
            0,
          ),
          waitingMinutes,
          breakMinutes: manifest.break.durationMinutes,
          returnTime: time(now),
          packages: manifest.deliveries.reduce((n, d) => n + d.packages, 0),
          weightKg: manifest.deliveries.reduce((n, d) => n + d.weightKg, 0),
        },
      },
      null,
      2,
    ),
  );
} finally {
  router?.destroy();
  runtime?.clear();
  readers.forEach((r) => r.dispose());
}
