import {
  AtlasRouter,
  type Position,
} from "../../../packages/routing/src/index";
import { AtlasReader } from "../../../packages/format/src/reader";
import { AtlasMap } from "../../../packages/renderer/src/map";
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(`route-${id}`);
const distance = (meters: number) =>
  meters >= 1000
    ? `${(meters / 1000).toFixed(2)} km`
    : `${Math.round(meters)} m`;
export class RouteControls {
  private router: AtlasRouter;
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
  private supported: boolean;
  constructor(
    readonly reader: AtlasReader,
    readonly map: AtlasMap,
  ) {
    this.router = new AtlasRouter(reader);
    this.supported =
      reader.index.manifest.capabilities.includes("walking-routing");
    const places = reader.index.manifest.places;
    const vienna = reader.index.manifest.name === "Vienna Plus";
    const a = vienna
        ? { name: "Stephansplatz", coordinates: [16.3731, 48.2085] as Position }
        : places.find((p) => p.name === "Vaduz"),
      b = vienna
        ? { name: "Praterstern", coordinates: [16.3918, 48.2194] as Position }
        : places.find((p) => p.name === "Schaan");
    if (a && b) button("example").textContent = `Try ${a.name} → ${b.name} ↗`;
    const on = (id: string, action: () => void) =>
      button(id).addEventListener("click", action, {
        signal: this.abort.signal,
      });
    on("start", () => this.pick(0));
    on("end", () => this.pick(1));
    on("calculate", () => void this.calculate());
    on("reverse", () => {
      this.points.reverse();
      this.names.reverse();
      this.map.setEndpoints(...this.points);
      void this.calculate();
    });
    on("clear", () => this.clear());
    on("example", () => {
      if (!a || !b) return;
      this.points = [a.coordinates, b.coordinates];
      this.names = [a.name, b.name];
      this.map.setEndpoints(...this.points);
      void this.calculate();
    });
    button("example").hidden = !a || !b;
    this.clear();
    if (!this.supported)
      element("route-hint").textContent =
        "This package has no walking graph. Rebuild it with the current generator.";
  }
  private update() {
    for (const [i, id] of ["start", "end"].entries()) {
      button(id).disabled = !this.supported || this.busy;
      button(id).setAttribute("aria-pressed", String(this.picking === i));
      element(`route-${id}-label`).textContent = this.names[i]!;
    }
    button("example").disabled = !this.supported || this.busy;
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
    if (!this.points[0] || !this.points[1]) return;
    const revision = ++this.revision;
    this.picking = null;
    this.busy = true;
    this.map.setRoute(null);
    this.update();
    const box = element("route-result");
    box.hidden = false;
    box.dataset.state = "loading";
    box.textContent = this.reader.cache.has("routing/walking")
      ? "Calculating in WASM…"
      : "Loading the walking network…";
    element("route-hint").textContent =
      "Routing uses the network independently of visible tiles.";
    try {
      const result = await this.router.route(this.points[0], this.points[1]);
      if (this.dead || revision !== this.revision) return;
      box.replaceChildren();
      box.dataset.state = result.status;
      if (result.status === "found") {
        const title = document.createElement("strong");
        title.textContent = distance(result.meters);
        const time = document.createElement("p");
        time.className = "route-time";
        const minutes =
          result.meters < 1 ? 0 : Math.max(1, Math.round(result.meters / 80));
        time.textContent = `~${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`} on foot · distance only`;
        const computation = document.createElement("p");
        computation.textContent = `${result.computeMs.toFixed(1)} ms in WASM · ${result.visited.toLocaleString()} nodes explored. ${result.graphCached ? "Cached graph; no network read for routing." : `${(result.graphBytes / 1_000_000).toFixed(1)} MB graph fetched once.`}`;
        const snap = document.createElement("p");
        snap.textContent = `Snapped A ${Math.round(result.start.distanceMeters)} m / B ${Math.round(result.end.distanceMeters)} m to the network. Dotted offsets are excluded from distance and time.`;
        box.append(title, time, computation, snap);
        this.map.setRoute(result);
        this.map.fitRoute();
      } else if (result.status === "no-route") {
        box.textContent =
          "No path connects these snapped points in this extract’s walking graph. A connection may exist outside the extract or on ways excluded by this profile. Try different points.";
      } else {
        box.textContent = `No eligible walking segment within ${result.limitMeters} m of ${result.endpoint === "start" ? "A" : "B"}. Pick closer to a road or path in this extract.`;
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
  destroy() {
    this.dead = true;
    this.revision++;
    this.abort.abort();
    this.router.destroy();
    this.map.endPicking("route");
    for (const id of [
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
