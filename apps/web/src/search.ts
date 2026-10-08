import {
  AtlasGeocoder,
  parseCoordinates,
  type Location,
  type Position,
} from "../../../packages/geocoding/src/index";
import { AtlasReader } from "../../../packages/format/src/reader";
import { AtlasMap } from "../../../packages/renderer/src/map";
import { RouteControls } from "./routing";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export class SearchControls {
  private geocoder: AtlasGeocoder;
  private abort = new AbortController();
  private revision = 0;
  private dead = false;
  private busy = false;
  private picking = false;
  private selected: { name: string; coordinates: Position } | null = null;
  private forward: boolean;
  private reverse: boolean;
  constructor(
    readonly reader: AtlasReader,
    readonly map: AtlasMap,
    readonly routing: RouteControls,
  ) {
    this.geocoder = new AtlasGeocoder(reader);
    this.forward =
      reader.index.manifest.capabilities.includes("location-search");
    this.reverse =
      reader.index.manifest.capabilities.includes("reverse-street");
    const on = (id: string, type: string, handler: (e: Event) => void) =>
      el(id).addEventListener(type, handler, { signal: this.abort.signal });
    on("location-form", "submit", (e) => {
      e.preventDefault();
      void this.search();
    });
    on("reverse-form", "submit", (e) => {
      e.preventDefault();
      void this.lookupText();
    });
    on("reverse-pick", "click", () => this.pick());
    on("search-clear", "click", () => {
      this.reset();
      this.endPick();
      el<HTMLInputElement>("location-query").value = "";
      this.message("Search inside this map’s extract.", "idle");
    });
    on("location-query", "input", () => this.reset());
    on("reverse-coordinates", "input", () => this.reset());
    on("search-route-start", "click", () => this.useForRoute(0));
    on("search-route-end", "click", () => this.useForRoute(1));
    el<HTMLInputElement>("location-query").disabled = !this.forward;
    el<HTMLInputElement>("reverse-coordinates").disabled = !this.reverse;
    const center = reader.index.manifest.places.find((p) => p.name === "Wien")
      ?.coordinates ?? [
      (reader.index.manifest.bounds[0] + reader.index.manifest.bounds[2]) / 2,
      (reader.index.manifest.bounds[1] + reader.index.manifest.bounds[3]) / 2,
    ];
    el<HTMLInputElement>("reverse-coordinates").value =
      `${center[1]!.toFixed(6)}, ${center[0]!.toFixed(6)}`;
    this.reset();
    this.message(
      this.forward
        ? "Search inside this map’s extract."
        : "This package has no search data. Rebuild it with the current generator.",
      "idle",
    );
  }
  private update() {
    el<HTMLButtonElement>("location-submit").disabled =
      !this.forward || this.busy;
    el<HTMLButtonElement>("reverse-submit").disabled =
      !this.reverse || this.busy;
    el<HTMLButtonElement>("reverse-pick").disabled = !this.reverse || this.busy;
    el("reverse-pick").setAttribute("aria-pressed", String(this.picking));
  }
  private message(text: string, state: string) {
    el("search-status").textContent = text;
    el("search-status").dataset.state = state;
  }
  private reset() {
    this.revision++;
    this.busy = false;
    this.selected = null;
    el("location-results").replaceChildren();
    el("location-results").hidden = true;
    el("search-detail").replaceChildren();
    el("search-detail").hidden = true;
    el("search-route-actions").hidden = true;
    this.map.clearLocation();
    this.update();
    this.message("Search inside this map’s extract.", "idle");
  }
  private endPick() {
    this.picking = false;
    this.map.endPicking("geocoding");
    this.update();
  }
  private pick() {
    if (this.picking) {
      this.endPick();
      return;
    }
    this.picking = true;
    this.map.beginPicking(
      "geocoding",
      (position) => {
        el<HTMLInputElement>("reverse-coordinates").value =
          `${position[1].toFixed(6)}, ${position[0].toFixed(6)}`;
        this.endPick();
        void this.lookup(position);
      },
      () => {
        this.picking = false;
        this.update();
      },
      "Choose a point for its nearest street. Drag to pan; Enter chooses the center; Escape cancels.",
    );
    this.update();
    if (matchMedia("(max-width: 700px)").matches)
      this.map.canvas.scrollIntoView({ block: "center" });
    this.map.canvas.focus({ preventScroll: true });
  }
  private async search() {
    this.endPick();
    this.reset();
    const revision = this.revision;
    this.busy = true;
    this.update();
    this.message("Searching locations…", "loading");
    try {
      const result = await this.geocoder.search(
        el<HTMLInputElement>("location-query").value,
      );
      if (this.dead || revision !== this.revision) return;
      const list = el("location-results");
      list.hidden = result.matches.length === 0;
      for (const record of result.matches) {
        const li = document.createElement("li"),
          button = document.createElement("button"),
          name = document.createElement("strong"),
          meta = document.createElement("span");
        button.type = "button";
        name.textContent = record.name;
        meta.textContent = `${record.kind === "poi" ? record.category.replaceAll("_", " ") : record.kind}${record.context ? ` · ${record.context}` : ""}`;
        button.append(name, meta);
        button.onclick = () => this.select(record);
        li.append(button);
        list.append(li);
      }
      this.message(
        result.total
          ? `${result.matches.length} of ${result.total} matches in this extract. ${result.cached ? "Using cached search data." : "Search data ready for offline use."}`
          : "No matching place or street in this extract. Try a shorter name or another spelling.",
        result.total ? "results" : "empty",
      );
    } catch (e) {
      if (!this.dead && revision === this.revision)
        this.message(e instanceof Error ? e.message : String(e), "error");
    } finally {
      if (!this.dead && revision === this.revision) {
        this.busy = false;
        this.update();
      }
    }
  }
  private detail(name: string, position: Position, description: string) {
    this.selected = { name, coordinates: position };
    const box = el("search-detail");
    box.replaceChildren();
    box.hidden = false;
    const title = document.createElement("strong"),
      note = document.createElement("p"),
      coords = document.createElement("code");
    title.textContent = name;
    note.textContent = description;
    coords.textContent = `${position[1].toFixed(6)}, ${position[0].toFixed(6)}`;
    box.append(title, note, coords);
    el("search-route-actions").hidden =
      !this.reader.index.manifest.capabilities.includes("walking-routing");
  }
  select(record: Location) {
    this.reset();
    this.endPick();
    this.map.focusLocation(
      record.coordinates,
      record.name,
      record.kind === "place" ? 14 : 17,
    );
    this.detail(
      record.name,
      record.coordinates,
      `${record.category.replaceAll("_", " ")}${record.context ? ` · ${record.context}` : ""}. Representative OSM location.`,
    );
    if (matchMedia("(max-width: 700px)").matches)
      this.map.canvas.scrollIntoView({ block: "center" });
  }
  private async lookupText() {
    try {
      await this.lookup(
        parseCoordinates(el<HTMLInputElement>("reverse-coordinates").value),
      );
    } catch (e) {
      this.reset();
      this.message(e instanceof Error ? e.message : String(e), "error");
    }
  }
  private async lookup(position: Position) {
    this.endPick();
    this.reset();
    const revision = this.revision;
    this.busy = true;
    this.update();
    this.message("Finding the nearest street…", "loading");
    try {
      const result = await this.geocoder.reverse(position);
      if (this.dead || revision !== this.revision) return;
      if (!result.match) {
        this.message(
          `No mapped street within ${result.limitMeters / 1000} km in this extract. This is not a worldwide lookup.`,
          "empty",
        );
        return;
      }
      const match = result.match,
        name =
          match.name || `Unnamed ${match.category.replaceAll("_", " ")} street`;
      this.detail(
        name,
        match.nearest,
        `${Math.round(match.distanceMeters)} m from the coordinate · ${match.category.replaceAll("_", " ")}. Straight-line distance, not a walking route.`,
      );
      this.map.focusLocation(
        match.nearest,
        name,
        17,
        match.coordinates,
        position,
      );
      this.message(
        `Nearest street found. ${result.cached ? "Using cached street data." : "Street data ready for offline use."}`,
        "found",
      );
    } catch (e) {
      if (!this.dead && revision === this.revision)
        this.message(e instanceof Error ? e.message : String(e), "error");
    } finally {
      if (!this.dead && revision === this.revision) {
        this.busy = false;
        this.update();
      }
    }
  }
  private useForRoute(i: 0 | 1) {
    if (this.selected) {
      this.endPick();
      this.routing.useLocation(
        i,
        this.selected.coordinates,
        this.selected.name,
      );
    }
  }
  destroy() {
    this.dead = true;
    this.revision++;
    this.abort.abort();
    this.endPick();
    for (const id of [
      "location-submit",
      "location-query",
      "reverse-submit",
      "reverse-pick",
      "reverse-coordinates",
    ])
      el<HTMLButtonElement>(id).disabled = true;
    el("location-results").replaceChildren();
    el("location-results").hidden = true;
    el("search-detail").hidden = true;
    el("search-route-actions").hidden = true;
  }
}
