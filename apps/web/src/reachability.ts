import type {
  Position,
  Reachable,
  TransportMode,
} from "../../../packages/routing/src/index";
import type { AtlasMap } from "../../../packages/renderer/src/map";
import { OperationSession, executionText } from "./operations";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const btn = (id: string) => el<HTMLButtonElement>(`iso-${id}`);
/** UI owns only selection and presentation; the operation session owns execution. */
export class ReachabilityControls {
  private origin: Position;
  private result?: Reachable;
  private busy = false;
  private picking = false;
  private revision = 0;
  private abort = new AbortController();
  constructor(
    readonly map: AtlasMap,
    readonly operations: OperationSession,
    readonly profileChanged: () => void,
  ) {
    const b = operations.reader.index.manifest.bounds;
    this.origin =
      operations.reader.index.manifest.name === "Vienna Plus"
        ? [16.3605, 48.2145]
        : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const select = el<HTMLSelectElement>("transport-profile");
    select.value = "walking";
    for (const option of select.options)
      option.disabled =
        option.value !== "walking" &&
        !operations.reader.index.manifest.transport;
    select.addEventListener(
      "change",
      () => {
        this.clear();
        operations.profile = select.value as TransportMode;
        profileChanged();
        this.refresh();
      },
      { signal: this.abort.signal },
    );
    const on = (id: string, action: () => void) =>
      btn(id).addEventListener("click", action, { signal: this.abort.signal });
    on("origin", () => this.pick());
    on("calculate", () => void this.calculate());
    on("compare", () => void this.calculate(true));
    on("clear", () => this.clear());
    on("resume", () => {
      const input = el<HTMLInputElement>("offline");
      input.checked = false;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      void this.calculate();
    });
    on("export", () => {
      if (!this.result) return;
      const blob = new Blob(
        [
          JSON.stringify(
            {
              ...this.result.contours,
              atlas: {
                snapshot: operations.reader.index.manifest.snapshot,
                profile: operations.profile,
                origin: this.origin,
                resolutionMeters: this.result.resolutionMeters,
              },
            },
            null,
            2,
          ),
        ],
        { type: "application/geo+json" },
      );
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `reachable-${operations.profile}.geojson`;
      a.click();
      URL.revokeObjectURL(url);
    });
    el("iso-duration").addEventListener("change", () => this.clear(), {
      signal: this.abort.signal,
    });
    el("iso-origin-label").textContent =
      `${this.origin[1].toFixed(5)}, ${this.origin[0].toFixed(5)}`;
    this.refresh();
  }
  private bands() {
    const value = Number(el<HTMLSelectElement>("iso-duration").value);
    return (
      {
        300: [60, 180, 300],
        600: [120, 300, 600],
        900: [300, 600, 900],
        1800: [600, 1200, 1800],
      } as Record<number, number[]>
    )[value]!;
  }
  refresh() {
    const supported =
      !!(
        this.operations.reader.index.manifest.transport ||
        this.operations.reader.index.manifest.routing?.cells
      ) && this.operations.enabled.has("routing");
    for (const id of ["origin", "calculate", "compare"])
      btn(id).disabled = !supported || this.busy;
    btn("compare").disabled ||=
      !this.operations.remote || this.operations.reader.offline;
    btn("export").disabled = !this.result || this.busy;
    btn("resume").disabled = !supported || this.busy;
    el<HTMLSelectElement>("iso-duration").disabled = this.busy;
    if (!supported)
      el("iso-result").textContent =
        "Enable routing and open a package with routing cells to explore reachable areas.";
  }
  private pick() {
    this.picking = !this.picking;
    btn("origin").setAttribute("aria-pressed", String(this.picking));
    if (!this.picking) {
      this.map.endPicking("isochrone");
      return;
    }
    this.map.beginPicking(
      "isochrone",
      (p) => {
        this.clear();
        this.origin = p;
        el("iso-origin-label").textContent =
          `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
        void this.calculate();
      },
      () => {
        this.picking = false;
        btn("origin").setAttribute("aria-pressed", "false");
      },
      "Choose an isochrone origin. Drag to pan; Enter chooses the center; Escape cancels.",
    );
    this.map.canvas.focus({ preventScroll: true });
  }
  private clear() {
    this.revision++;
    this.operations.cancelRoute();
    this.busy = false;
    this.result = undefined;
    this.picking = false;
    btn("origin").setAttribute("aria-pressed", "false");
    this.map.endPicking("isochrone");
    this.map.setReachable(null);
    btn("resume").hidden = true;
    el("iso-legend").hidden = true;
    el("iso-proof").textContent = "";
    el("iso-result").textContent =
      "Choose an origin or show its reachable area.";
    this.refresh();
  }
  private async calculate(compare = false) {
    const revision = ++this.revision;
    this.busy = true;
    this.map.endPicking("isochrone");
    this.picking = false;
    btn("origin").setAttribute("aria-pressed", "false");
    btn("resume").hidden = true;
    this.refresh();
    el("iso-proof").textContent = "";
    const box = el("iso-result");
    box.dataset.state = "loading";
    box.textContent = `Exploring the ${this.operations.profile} network…`;
    try {
      const proof = compare
        ? await this.operations.compareIsochrone(this.origin, this.bands())
        : undefined;
      const r =
        proof?.device ??
        (await this.operations.isochrone(this.origin, this.bands()));
      if (revision !== this.revision) return;
      if (proof)
        el("iso-proof").textContent = proof.same
          ? "Match: identical time bands and GeoJSON contours on device and server."
          : "The results differ or a search is incomplete.";
      box.dataset.state = r.status;
      if (r.cells && r.execution.side === "device")
        this.operations.onRouteProgress?.(r.cells);
      if (r.status === "reachable") {
        this.result = r;
        this.map.setReachable(r);
        const points = r.contours.features.flatMap((f) =>
          f.geometry.coordinates.flat(2),
        ) as Position[];
        if (points.length) this.map.fitPositions(points);
        const legend = el("iso-legend");
        legend.replaceChildren();
        legend.hidden = false;
        r.contours.features.forEach((f, i) => {
          const item = document.createElement("span");
          item.style.setProperty(
            "--band",
            ["#22776f", "#578fac", "#c89949", "#a479ae"][i]!,
          );
          item.textContent = `${f.properties.minutes} min`;
          legend.append(item);
        });
        box.textContent = `${this.operations.profile} · ${r.segments.toLocaleString()} reachable directed segments · ${Math.round(r.resolutionMeters)} m contour grid. ${executionText(r.execution)}. Origin snapped ${Math.round(r.start.distanceMeters)} m.`;
      } else if (r.status === "missing-data") {
        this.result = undefined;
        this.map.setReachable(null);
        box.textContent = `Search paused: ${r.missing.length} missing cells. ${r.reason} Reconnect to resume the same search.`;
        btn("resume").hidden = false;
      } else if (r.status === "budget-exceeded") {
        this.result = undefined;
        this.map.setReachable(null);
        box.textContent =
          "Search reached the prototype memory limit. Choose a shorter time. No partial area is presented as complete.";
      } else
        box.textContent =
          "No eligible network close enough to this origin. Choose a point closer to a road or path.";
    } catch (e) {
      if (revision === this.revision) {
        box.dataset.state = "error";
        box.textContent = String(e);
      }
    } finally {
      if (revision === this.revision) {
        this.busy = false;
        this.refresh();
      }
    }
  }
  destroy() {
    this.revision++;
    this.abort.abort();
    this.map.endPicking("isochrone");
    this.map.setReachable(null);
  }
}
