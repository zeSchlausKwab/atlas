import { AtlasReader, HttpSource } from "../../../packages/format/src/reader";
import { type BlockStore } from "../../../packages/format/src/store";
import {
  type Manifest,
  type TransportMode,
} from "../../../packages/format/src/index";
import {
  RoutingComposition,
  graphIdentity,
} from "../../../packages/routing/src/composition";
import type { RoutingProgress } from "../../../packages/routing/src/paged";
import type { Position } from "../../../packages/routing/src/index";
import type { CompositionMap } from "../../../packages/renderer/src/composition";
import { WorkerRouter } from "./worker-router";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`composition-route-${id}`) as T;
interface Source {
  url: string;
  manifest: Manifest;
}
export class CompositionRouting {
  private sources: Source[] = [];
  private readers: AtlasReader[] = [];
  private provider?: RoutingComposition;
  private worker?: WorkerRouter;
  private signature = "";
  private serial = 0;
  private busy = false;
  private compatible = false;
  constructor(
    private map: CompositionMap,
    private store: BlockStore,
  ) {
    el<HTMLFormElement>("form").onsubmit = (e) => {
      e.preventDefault();
      void this.run();
    };
    el("cancel").onclick = () => {
      this.cancel();
      el("result").textContent = "Routing cancelled.";
    };
    for (const field of ["budget", "mode", "offline"])
      el(field).onchange = () => {
        this.cancel();
        this.map.setRoute();
        el("result").textContent = "Settings changed. Route when ready.";
      };
    for (const field of ["start", "end"]) {
      el(field).oninput = () => {
        this.cancel();
        this.map.setRoute();
      };
      el(`pick-${field}`).onclick = () => {
        this.cancel();
        this.map.setRoute();
        el("result").textContent =
          `Click the map to choose ${field === "start" ? "A" : "B"}. Escape cancels.`;
        this.map.onPick = (p) => {
          el<HTMLInputElement>(field).value =
            `${p[1].toFixed(6)}, ${p[0].toFixed(6)}`;
          this.map.onPick = undefined;
          try {
            this.endpoints();
            el("result").textContent = "Point selected. Route when ready.";
          } catch (e) {
            el("result").textContent = String(e);
          }
        };
      };
    }
    this.map.onCancelPick = () => {
      this.map.onPick = undefined;
      el("result").textContent = "Point selection cancelled.";
    };
  }
  configure(sources: Source[]) {
    sources = sources.filter((s) => !!s.manifest.transport);
    const signature = sources
      .map((s) => s.url + "@" + s.manifest.snapshot)
      .sort()
      .join("|");
    if (signature === this.signature) return;
    this.signature = signature;
    this.cancel();
    this.sources = sources;
    this.map.setRoute();
    this.map.setEndpoints([]);
    const ids = sources.map((s) => graphIdentity(s.manifest));
    const compatible = (this.compatible =
      !!ids.length && !!ids[0] && ids.every((id) => id === ids[0]));
    el<HTMLButtonElement>("run").disabled = !compatible;
    el("compatibility").textContent = compatible
      ? `${sources.length} transport maps · shared graph ${ids[0]!.slice(0, 12)}… · computed in a Web Worker`
      : "Choose transport excerpts from one shared compiled graph to route across them.";
    el("sources").replaceChildren();
  }
  private endpoints(): [Position, Position] {
    const parse = (id: string): Position => {
      const values = el<HTMLInputElement>(id)
        .value.split(",")
        .map((s) => s.trim());
      const [lat, lon] = values.map(Number);
      if (
        values.length !== 2 ||
        values.some((s) => !s) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat!) > 85 ||
        Math.abs(lon!) > 180
      )
        throw new Error("Use latitude, longitude for both endpoints.");
      return [lon!, lat!];
    };
    const points: [Position, Position] = [parse("start"), parse("end")];
    this.map.setEndpoints(points);
    return points;
  }
  private progress(p: RoutingProgress) {
    el("result").textContent =
      `${p.phase} · ${p.visited.toLocaleString()} states visited · ${p.loadedCells} cells · ${(p.fetchedBytes / 1048576).toFixed(2)} MiB fetched · ${(p.memoryBytes / 1048576).toFixed(1)} MiB estimated router memory`;
    const owners = new Map<string, number>();
    for (const cell of p.cells) {
      const owner = this.provider?.served.get(cell.key);
      if (owner) owners.set(owner.source, (owners.get(owner.source) ?? 0) + 1);
    }
    el("sources").replaceChildren(
      ...this.sources.map((s) => {
        const li = document.createElement("li");
        li.textContent = `${s.manifest.name}: ${owners.get(s.url) ?? 0} cells`;
        return li;
      }),
    );
  }
  async run() {
    if (this.busy || !this.compatible) return;
    const serial = ++this.serial;
    this.busy = true;
    el("result").dataset.state = "loading";
    this.map.onPick = undefined;
    el<HTMLButtonElement>("run").disabled = true;
    el<HTMLButtonElement>("cancel").disabled = false;
    try {
      const [a, b] = this.endpoints();
      this.map.setRoute();
      const offline = el<HTMLInputElement>("offline").checked;
      if (!this.worker) {
        el("result").textContent = "Opening routing directories…";
        const sources = [...this.sources];
        const readers = sources.map((s) => {
          const http = new HttpSource(s.url);
          return new AtlasReader(
            {
              read: (start, end, signal) =>
                offline
                  ? Promise.reject(
                      new TypeError("Network disabled for routing"),
                    )
                  : http.read(start, end, signal),
            },
            undefined,
            {
              store: this.store,
              sourceId: s.url,
              purposes: ["routing"],
              cacheBudgets: { routing: 8 * 1048576 },
              directoryBudget: 2 * 1048576,
            },
          );
        });
        this.readers = readers;
        try {
          await Promise.all(
            readers.map(async (r, i) => {
              await r.open();
              if (r.index.manifest.snapshot !== sources[i]!.manifest.snapshot)
                throw new Error(
                  "Source snapshot changed. Reload the composition.",
                );
            }),
          );
        } catch (e) {
          readers.forEach((r) => r.dispose());
          throw e;
        }
        if (serial !== this.serial) {
          readers.forEach((r) => r.dispose());
          return;
        }
        this.provider = new RoutingComposition(
          readers.map((reader, i) => ({ id: sources[i]!.url, reader })),
        );
        this.worker = new WorkerRouter(this.provider, (p) => this.progress(p), {
          searchStates: Number(el<HTMLSelectElement>("budget").value),
        });
      }
      this.readers.forEach((r) => (r.offline = offline));
      const mode = el<HTMLSelectElement>("mode").value as TransportMode;
      const result = await this.worker.route(a, b, mode);
      if (serial !== this.serial) return;
      if (result.status === "found") {
        this.map.setRoute(result.coordinates);
        el("result").textContent =
          `${mode}: ${(result.meters / 1000).toFixed(1)} km · ${result.seconds === undefined ? "" : `${Math.round(result.seconds / 60)} min · `}${result.cells?.loadedCells ?? 0} cells · ${(result.graphBytes / 1048576).toFixed(2)} MiB fetched · computed on this device`;
      } else
        el("result").textContent =
          result.status === "missing-data"
            ? result.reason
            : result.status === "budget-exceeded"
              ? "Search limit reached. Increase the search limit or choose a shorter journey."
              : result.status === "unsnappable"
                ? `No ${mode} road within ${result.limitMeters} m of the ${result.endpoint}.`
                : "No connected route found in this graph.";
      el("result").dataset.state = result.status;
    } catch (error) {
      if (serial === this.serial) {
        el("result").textContent = String(error);
        this.cancel();
        el("result").dataset.state = "error";
      }
    } finally {
      if (serial === this.serial) {
        this.busy = false;
        el<HTMLButtonElement>("run").disabled = !this.compatible;
        el<HTMLButtonElement>("cancel").disabled = true;
      }
    }
  }
  cancel() {
    this.serial++;
    this.worker?.cancel();
    this.worker = undefined;
    this.provider = undefined;
    this.readers.forEach((r) => r.dispose());
    this.readers = [];
    this.busy = false;
    this.map.onPick = undefined;
    el<HTMLButtonElement>("cancel").disabled = true;
    el<HTMLButtonElement>("run").disabled = !this.compatible;
    el("result").dataset.state = "idle";
  }
  destroy() {
    this.cancel();
  }
}
