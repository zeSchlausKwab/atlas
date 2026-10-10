import { isRoutingCell } from "../../../packages/format/src/index";
import type { RoutingProgress } from "../../../packages/routing/src/paged";
import { OperationSession, executionText } from "./operations";
import { type Position } from "../../../packages/routing/src/index";
import { AtlasReader } from "../../../packages/format/src/reader";
import type { WorkspaceMap } from "../../../packages/renderer/src/workspace-map";
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(`route-${id}`);
const distance = (meters: number) =>
  meters >= 1000
    ? `${(meters / 1000).toFixed(2)} km`
    : `${Math.round(meters)} m`;
export class RouteControls {
  private router: OperationSession;
  private points: [Position | null, Position | null] = [null, null];
  private names: [string, string] = [
    "Choose start on map",
    "Choose destination on map",
  ];
  private picking: 0 | 1 | null = null;
  private busy = false;
  private revision = 0;
  private dead = false;
  private abort = new AbortController();
  private unsubscribeProgress?: () => void;
  private supported: boolean;
  private cells = new Map<string, { key: string; state: string }>();
  private progress(p: RoutingProgress) {
    this.cells = new Map(p.cells.map((c) => [c.key, c]));
    this.drawCells();
    const composition = this.operations.composition;
    element("route-sources").replaceChildren(
      ...(composition?.sources ?? []).map((s) => {
        const li = document.createElement("li");
        const count = p.cells.filter(
          (c) => composition!.served.get(c.key)?.source === s.id,
        ).length;
        li.textContent = `${s.reader.index.manifest.name}: ${count} cells`;
        return li;
      }),
    );
    element("route-cell-metrics").textContent =
      `${p.loadedCells} cells used · ${p.reusedCells} reused · ${(p.fetchedBytes / 1e6).toFixed(2)} MB downloaded · ${(p.memoryBytes / 1048576).toFixed(1)} MiB estimated engine memory · ${p.computeMs.toFixed(0)} ms compute. ${this.reader.options.store?.available ? "Cached on this device (128 MiB limit)." : "Persistent storage unavailable; keep this tab open."}`;
  }
  private drawCells() {
    this.map.setRoutingCells(
      element<HTMLInputElement>("route-cell-overlay").checked
        ? [...this.cells.values()]
        : [],
    );
  }

  constructor(
    readonly reader: AtlasReader,
    readonly map: WorkspaceMap,
    readonly operations: OperationSession,
  ) {
    this.router = operations;
    this.supported =
      reader.index.manifest.capabilities.includes("walking-routing") ||
      !!reader.index.manifest.transport;
    const places = reader.index.manifest.places;
    const composed = operations.composed;
    const covered = (point: Position) =>
      (operations.composition?.sources ?? [{ reader }]).some((s) => {
        const [w, south, e, n] = s.reader.index.manifest.bounds;
        return (
          point[0] >= w && point[0] <= e && point[1] >= south && point[1] <= n
        );
      });
    const vienna = reader.index.manifest.name === "Vienna Plus";
    const danube =
      (composed || !vienna) &&
      covered([16.3696, 48.2027]) &&
      covered([17.1128, 48.1452]);
    const a = danube
        ? { name: "Vienna", coordinates: [16.3696, 48.2027] as Position }
        : vienna
          ? {
              name: "Stephansplatz",
              coordinates: [16.3731, 48.2085] as Position,
            }
          : places.find((p) => p.name === "Vaduz"),
      b = danube
        ? { name: "Bratislava", coordinates: [17.1128, 48.1452] as Position }
        : vienna
          ? { name: "Praterstern", coordinates: [16.3918, 48.2194] as Position }
          : places.find((p) => p.name === "Schaan");
    if (a && b) button("example").textContent = `Try ${a.name} → ${b.name} ↗`;
    const on = (id: string, action: () => void) =>
      button(id).addEventListener("click", action, {
        signal: this.abort.signal,
      });
    on("start", () => this.pick(0));
    on("end", () => this.pick(1));
    on("compare", () => void this.compare());
    on("calculate", () => void this.calculate());
    on("reverse", () => {
      this.points.reverse();
      this.names.reverse();
      this.map.setEndpoints(...this.points);
      void this.calculate();
    });
    on("clear", () => this.clear());
    on("example", () => {
      const start =
        !composed && vienna && this.operations.profile === "driving"
          ? { name: "Schottentor", coordinates: [16.3605, 48.2145] as Position }
          : a;
      if (!start || !b) return;
      this.points = [start.coordinates, b.coordinates];
      this.names = [start.name, b.name];
      this.map.setEndpoints(...this.points);
      this.map.fitPositions([start.coordinates, b.coordinates]);
      void this.calculate();
    });
    button("example").hidden = !a || !b;
    this.clear();
    element<HTMLSelectElement>("route-budget").value = String(
      operations.routingBudget.searchStates ?? 250000,
    );
    element("route-budget").addEventListener(
      "change",
      () => {
        operations.setRoutingBudget({
          searchStates: Number(
            element<HTMLSelectElement>("route-budget").value,
          ),
        });
        this.profileChanged();
      },
      { signal: this.abort.signal },
    );
    on("cancel", () => {
      operations.cancelRoute();
      this.revision++;
      this.busy = false;
      this.update();
      element("route-result").textContent = "Routing cancelled.";
      element("route-result").dataset.state = "cancelled";
    });
    element("route-cell-panel").hidden = !(
      operations.composition ||
      reader.index.manifest.routing?.cells ||
      reader.index.manifest.transport
    );
    this.unsubscribeProgress = operations.subscribeProgress((p) => {
      if (!this.dead) this.progress(p);
    });
    element("route-cell-overlay").addEventListener(
      "change",
      () => this.drawCells(),
      { signal: this.abort.signal },
    );
    on("resume", () => {
      const input = element<HTMLInputElement>("offline");
      input.checked = false;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      void this.calculate();
    });
    on("beyond", () => {
      this.points = [
        [16.3731, 48.2085],
        [16.3124, 48.1859],
      ];
      this.names = ["Stephansplatz", "Schönbrunn"];
      map.setEndpoints(...this.points);
      map.fitPositions(this.points.filter((p): p is Position => p !== null));
      void this.calculate();
    });
    button("beyond").hidden = !vienna;
    void reader.options.store
      ?.keys(reader.index.manifest.snapshot)
      .then((keys) => {
        if (this.dead) return;
        for (const key of keys)
          if (isRoutingCell(key) && !this.cells.has(key))
            this.cells.set(key, { key, state: "cached" });
        this.drawCells();
      });
    if (!this.supported)
      element("route-hint").textContent =
        "This package has no walking graph. Rebuild it with the current generator.";
  }
  profileChanged() {
    this.clear();
    this.map.setRoute(null);
    this.cells.clear();
    this.drawCells();
    this.refresh();
  }
  refresh() {
    if (
      !this.operations.composed &&
      this.reader.index.manifest.name === "Vienna Plus"
    )
      button("example").textContent =
        `Try ${this.operations.profile === "driving" ? "Schottentor" : "Stephansplatz"} → Praterstern ↗`;
    element("route-proof").hidden = true;
    if (this.busy) this.operations.cancelRoute();
    this.revision++;
    this.busy = false;
    this.picking = null;
    this.supported = this.operations.routingAvailable;
    const scope = element("route-composition-scope");
    scope.hidden = !this.operations.composed;
    scope.textContent =
      this.operations.compositionError ??
      (this.operations.mode === "server"
        ? "Choose This device to route across the composition. Server operations use only Tool source."
        : `${this.operations.composition?.sources.length ?? 0} transport maps · shared graph ${this.operations.composition?.snapshot.slice(0, 12)}… · cells fetched on demand.`);
    if (!this.supported) this.map.setRoute(null);
    this.update();
  }
  private update() {
    button("cancel").disabled = !this.busy;
    button("compare").disabled =
      this.operations.composed ||
      !this.supported ||
      this.busy ||
      !this.points[0] ||
      !this.points[1] ||
      !this.operations.remote ||
      this.reader.offline;
    for (const [i, id] of ["start", "end"].entries()) {
      button(id).disabled = !this.supported || this.busy;
      button(id).setAttribute("aria-pressed", String(this.picking === i));
      element(`route-${id}-label`).textContent = this.names[i]!;
    }
    button("example").disabled = !this.supported || this.busy;
    button("beyond").disabled = !this.supported || this.busy;
    button("resume").disabled = !this.supported || this.busy;
    for (const id of ["calculate", "reverse"])
      button(id).disabled =
        !this.supported || this.busy || !this.points[0] || !this.points[1];
    button("clear").disabled =
      !this.supported ||
      (!this.points[0] && !this.points[1] && this.picking === null);
    if (this.picking === null) this.map.endPicking("route");
    else
      this.map.beginPicking(
        "route",
        (position) => this.choosePoint(position),
        () => {
          this.picking = null;
          this.update();
        },
        `Choose ${this.picking === 0 ? "start A" : "destination B"} on the map. Drag to pan; Enter chooses the center; Escape cancels.`,
      );
  }
  private choosePoint(position: Position) {
    if (this.picking === null || this.busy) return;
    const i = this.picking;
    element("route-proof").hidden = true;
    this.points[i] = position;
    this.names[i] = `${position[1].toFixed(5)}, ${position[0].toFixed(5)}`;
    this.map.setEndpoints(...this.points);
    if (this.points[0] && this.points[1]) void this.calculate();
    else this.pick(i === 0 ? 1 : 0);
  }
  useLocation(i: 0 | 1, position: Position, name: string) {
    if (!this.supported) return;
    this.revision++;
    this.busy = false;
    this.picking = null;
    element("route-proof").hidden = true;
    this.points[i] = position;
    this.names[i] = name;
    this.map.setEndpoints(...this.points);
    this.update();
    if (this.points[0] && this.points[1]) void this.calculate();
    else this.pick(i === 0 ? 1 : 0);
  }
  private pick(i: 0 | 1) {
    this.picking = this.picking === i ? null : i;
    const text =
      this.picking === null
        ? "Pick A and B on the map, or try the example."
        : `Choose ${this.picking === 0 ? "start A" : "destination B"} on the map. Drag to pan; Enter chooses the map center.`;
    element("route-hint").textContent = text;
    this.update();
    if (this.picking !== null) {
      if (matchMedia("(max-width: 700px)").matches)
        this.map.canvas.scrollIntoView({ block: "center" });
      this.map.canvas.focus({ preventScroll: true });
    }
  }
  private clear() {
    this.operations.cancelRoute();
    button("resume").hidden = true;
    element("route-proof").hidden = true;
    this.revision++;
    this.busy = false;
    this.points = [null, null];
    this.names = ["Choose start on map", "Choose destination on map"];
    this.picking = null;
    this.map.setEndpoints(null, null);
    element("route-result").hidden = true;
    element("route-hint").textContent =
      "Pick A and B on the map, or try the example.";
    this.update();
  }
  private async calculate() {
    element("route-proof").hidden = true;
    button("resume").hidden = true;
    if (!this.points[0] || !this.points[1]) return;
    const revision = ++this.revision;
    this.picking = null;
    this.busy = true;
    for (const [key, c] of this.cells)
      if (c.state === "missing" || c.state === "loading")
        this.cells.delete(key);
    this.drawCells();
    this.map.setRoute(null);
    this.update();
    const box = element("route-result");
    box.hidden = false;
    box.dataset.state = "loading";
    box.textContent =
      this.operations.mode === "server"
        ? "Calculating on the server…"
        : this.reader.cache.has("routing/walking")
          ? "Calculating in WASM…"
          : `Loading the ${this.operations.profile} network…`;
    element("route-hint").textContent =
      "Routing uses the network independently of visible tiles.";
    try {
      const result = await this.router.route(this.points[0], this.points[1]);
      if (this.dead || revision !== this.revision) return;
      if (result.cells && result.execution.side === "device")
        this.progress(result.cells);
      else if (result.cells)
        element("route-cell-metrics").textContent =
          `Server used ${result.cells.loadedCells} routing cells · ${(result.cells.fetchedBytes / 1e6).toFixed(2)} MB read on server · ${(result.cells.memoryBytes / 1048576).toFixed(1)} MiB estimated engine memory. Coverage overlay shows this device's cache.`;
      box.replaceChildren();
      box.dataset.state = result.status;
      if (result.status === "found") {
        const title = document.createElement("strong");
        title.textContent = distance(result.meters);
        const time = document.createElement("p");
        time.className = "route-time";
        const minutes =
          result.meters < 1
            ? 0
            : Math.max(
                1,
                Math.round(
                  (result.seconds ?? result.meters / (4.8 / 3.6)) / 60,
                ),
              );
        time.textContent = `~${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`} ${this.operations.profile} · estimated travel time`;
        const computation = document.createElement("p");
        computation.textContent = `${executionText(result.execution)} · ${result.visited.toLocaleString()} nodes explored. ${result.execution.side === "server" ? "The network stayed on the server." : result.cells ? "Using selectively loaded routing cells." : result.graphCached ? "Using the cached walking graph." : "Walking graph is now available on this device."}`;
        const snap = document.createElement("p");
        snap.textContent = `Snapped A ${Math.round(result.start.distanceMeters)} m / B ${Math.round(result.end.distanceMeters)} m to the network. Dotted offsets are excluded from distance and time.`;
        box.append(title, time, computation, snap);
        this.map.setRoute(result);
        this.map.fitRoute();
      } else if (result.status === "no-route") {
        box.textContent =
          "No path connects these snapped points in this extract’s transport graph. A connection may exist outside the extract or on ways excluded by this profile. Try different points.";
      } else if (result.status === "missing-data") {
        box.textContent = `Search paused: ${result.missing.length} routing ${result.missing.length === 1 ? "cell is" : "cells are"} missing. ${result.reason} Reconnect and resume; a missing cell does not mean there is no route.`;
        button("resume").hidden = false;
      } else if (result.status === "budget-exceeded") {
        box.textContent =
          "Search reached the configured limit. Increase Client search limit or try a shorter route. This is not a no-route result.";
      } else {
        box.textContent = `No eligible ${this.operations.profile} segment within ${result.limitMeters} m of ${result.endpoint === "start" ? "A" : "B"}. Pick closer to a road or path in this extract.`;
      }
    } catch (e) {
      if (this.dead || revision !== this.revision) return;
      box.dataset.state = "error";
      box.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      if (!this.dead && revision === this.revision) {
        this.busy = false;
        this.update();
      }
    }
  }
  private async compare() {
    if (!this.points[0] || !this.points[1]) return;
    const revision = ++this.revision;
    this.busy = true;
    this.update();
    const box = element("route-proof");
    box.hidden = false;
    box.textContent = "Running both engines against the same snapshot…";
    try {
      const proof = await this.operations.compareRoute(
        this.points[0],
        this.points[1],
      );
      if (this.dead || revision !== this.revision) return;
      box.dataset.state = proof.same ? "match" : "different";
      box.textContent = proof.same
        ? `Match: identical ${proof.device.status === "found" ? `${distance(proof.device.meters)} route, coordinates and OSM way sequence` : proof.device.status} on this device and server. Snapshot ${proof.device.snapshot.slice(0, 12)}. Server response ${(proof.server.execution.responseBytes / 1000).toFixed(1)} KB.`
        : "The results differ; check the operation details.";
    } catch (e) {
      if (revision === this.revision) {
        box.dataset.state = "error";
        box.textContent = String(e);
      }
    } finally {
      if (!this.dead && revision === this.revision) {
        this.busy = false;
        this.update();
      }
    }
  }
  destroy() {
    this.dead = true;
    this.revision++;
    this.abort.abort();

    this.unsubscribeProgress?.();
    this.operations.cancelRoute();
    this.map.setRoutingCells([]);
    this.map.endPicking("route");
    for (const id of [
      "cancel",
      "compare",
      "example",
      "start",
      "end",
      "calculate",
      "reverse",
      "clear",
    ])
      button(id).disabled = true;
    element("route-result").hidden = true;
  }
}
