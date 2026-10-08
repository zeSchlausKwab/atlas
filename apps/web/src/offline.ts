import type { OperationSession } from "./operations";
import {
  AtlasReader,
  FileSource,
  HttpSource,
} from "../../../packages/format/src/reader";
import { AtlasMap } from "../../../packages/renderer/src/map";
import { plan, type Selection } from "../../../packages/offline/src/index";
import {
  validatePolygon,
  type Polygon,
} from "../../../packages/offline/src/geometry";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`world-${id}`) as T;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
export class OfflineControls {
  private polygon: Polygon = [];
  private drawing = false;
  private busy = false;
  private revision = 0;
  private blob?: Blob;
  private worker?: Worker;
  private abort = new AbortController();
  constructor(
    readonly reader: AtlasReader,
    readonly map: AtlasMap,
    readonly open: (file: Blob) => Promise<void>,
    readonly operations: OperationSession,
    readonly mapData: () => Pick<
      Selection,
      "layers" | "placeNames" | "streetNames" | "pois"
    > = () => ({}),
  ) {
    const m = reader.index.manifest;
    el<HTMLInputElement>("name").value = `My ${m.name}`;
    for (const id of ["min", "max"]) {
      const select = el<HTMLSelectElement>(id);
      select.replaceChildren();
      for (let z = m.minZoom; z <= m.maxZoom; z++)
        select.add(new Option(`z${z}`, String(z)));
      select.value = String(id === "min" ? m.minZoom : m.maxZoom);
      select.addEventListener(
        "change",
        () => {
          this.blob = undefined;
          this.update();
        },
        { signal: this.abort.signal },
      );
    }
    for (const id of ["routing", "search", "queries"]) {
      const input = el<HTMLInputElement>(id);
      input.checked = false;
      input.disabled = !m.capabilities.includes(
        id === "routing"
          ? "walking-routing"
          : id === "search"
            ? "location-search"
            : "peak-query",
      );
      input.addEventListener(
        "change",
        () => {
          this.blob = undefined;
          this.update();
        },
        { signal: this.abort.signal },
      );
    }
    el("name").addEventListener(
      "input",
      () => {
        this.blob = undefined;
        this.update();
      },
      { signal: this.abort.signal },
    );
    const on = (id: string, fn: () => void) =>
      el(id).addEventListener("click", fn, { signal: this.abort.signal });
    on("draw", () => this.draw());
    on("finish", () => this.finish());
    on("map-finish", () => this.finish());
    on("map-undo", () => {
      this.polygon.pop();
      this.blob = undefined;
      this.update();
    });
    on("map-cancel", () => this.cancel());
    on("undo", () => {
      this.polygon.pop();
      this.blob = undefined;
      this.update();
    });
    on("clear", () => this.cancel());
    on("export", () => this.export());
    on("download", () => {
      if (!this.blob) return;
      const url = URL.createObjectURL(this.blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `${this.selection().name.replace(/[^\p{L}\p{N}-]+/gu, "-")}.atlas`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    on("open", () => {
      if (this.blob) void this.open(this.blob);
    });
    this.update();
  }
  refresh() {
    this.worker?.terminate();
    this.worker = undefined;
    this.busy = false;
    this.blob = undefined;
    for (const p of ["routing", "search", "queries"] as const)
      if (!this.operations.enabled.has(p))
        el<HTMLInputElement>(p).checked = false;
    void this.update();
  }
  private selection(): Selection {
    return {
      ...this.mapData(),
      polygon: this.polygon,
      minZoom: Number(el<HTMLSelectElement>("min").value),
      maxZoom: Number(el<HTMLSelectElement>("max").value),
      routing: el<HTMLInputElement>("routing").checked,
      search: el<HTMLInputElement>("search").checked,
      queries: el<HTMLInputElement>("queries").checked,
      name: el<HTMLInputElement>("name").value,
    };
  }
  private message(s: string) {
    el("status").textContent = s;
    if (this.drawing) el("map-status").textContent = s;
  }
  private draw() {
    this.blob = undefined;
    this.polygon = [];
    this.drawing = true;
    this.map.beginPicking(
      "offline",
      (point) => {
        this.polygon.push(point);
        this.update();
      },
      () => this.cancel(),
      "Click corners, then Finish area. Enter finishes · Space adds the center · Escape cancels.",
      () => this.finish(),
    );
    this.update();
    this.map.canvas.focus({ preventScroll: true });
    if (matchMedia("(max-width: 700px)").matches)
      this.map.canvas.scrollIntoView({ block: "center" });
  }
  private cancel() {
    this.map.endPicking("offline");
    this.drawing = false;
    this.polygon = [];
    this.blob = undefined;
    void this.update();
  }
  private finish() {
    try {
      validatePolygon(this.polygon);
      this.drawing = false;
      this.map.endPicking("offline");
      this.update();
    } catch (e) {
      this.message(String(e));
    }
  }
  private async update() {
    const revision = ++this.revision;
    el("map-tools").hidden = !this.drawing;
    el<HTMLButtonElement>("map-finish").disabled = this.polygon.length < 3;
    el<HTMLButtonElement>("map-undo").disabled = !this.polygon.length;
    this.map.setSelection(this.polygon, !this.drawing);
    for (const id of ["name", "min", "max"])
      el<HTMLInputElement>(id).disabled = this.busy;
    el<HTMLInputElement>("routing").disabled =
      this.busy ||
      !this.operations.enabled.has("routing") ||
      !this.reader.index.manifest.routing;
    el<HTMLInputElement>("search").disabled =
      this.busy ||
      !this.operations.enabled.has("search") ||
      !this.reader.index.manifest.capabilities.includes("location-search");
    el<HTMLInputElement>("queries").disabled =
      this.busy ||
      !this.operations.enabled.has("queries") ||
      !this.reader.index.manifest.capabilities.includes("peak-query");
    el<HTMLButtonElement>("draw").disabled = this.busy;
    el<HTMLButtonElement>("finish").disabled =
      this.busy || !this.drawing || this.polygon.length < 3;
    el<HTMLButtonElement>("undo").disabled = this.busy || !this.polygon.length;
    el<HTMLButtonElement>("clear").disabled = this.busy || !this.polygon.length;
    el("ready").hidden = !this.blob;
    el<HTMLButtonElement>("export").disabled = true;
    if (this.busy) return;
    if (this.blob) {
      this.message(
        `Ready · ${mb(this.blob.size)}. Save the file, then open it here without map-server requests.`,
      );
      return;
    }
    if (!this.polygon.length) {
      this.message("Draw an area to take its map and knowledge with you.");
      return;
    }
    if (this.drawing) {
      this.message(
        `${this.polygon.length} corners. Add more, then finish your area.`,
      );
      return;
    }
    try {
      this.message("Measuring the selected area…");
      const p = await plan(this.reader, this.selection());
      if (revision !== this.revision) return;
      el<HTMLButtonElement>("export").disabled = p.tileBytes > 256_000_000;
      this.message(
        `${p.tiles.length.toLocaleString()} tiles · up to ${mb(p.bytes)} to read before clipping. Final file is measured after export.`,
      );
    } catch (e) {
      if (revision === this.revision) this.message(String(e));
    }
  }
  private export() {
    try {
      this.operations.checkOffline(this.selection());
    } catch (e) {
      this.message(String(e));
      return;
    }
    if (this.operations.mode === "server") {
      void this.exportOnServer();
      return;
    }
    if (this.reader.offline && this.reader.source instanceof HttpSource) {
      this.message(
        "Turn off “Cache only” to fetch the source blocks for export.",
      );
      return;
    }
    this.busy = true;
    this.blob = undefined;
    this.update();
    this.message("Opening source snapshot…");
    const worker = (this.worker = new Worker("/offline-worker.js", {
      type: "module",
    }));
    const fail = (message: string) => {
      worker.terminate();
      this.busy = false;
      void this.update().then(() => this.message(message));
    };
    worker.onerror = (e) => fail(e.message);
    worker.onmessage = (e) => {
      if (e.data.error) {
        fail(e.data.error);
        return;
      }
      if (e.data.blob) {
        this.blob = e.data.blob;
        this.busy = false;
        worker.terminate();
        this.update();
        this.message(
          `Ready · ${mb(this.blob!.size)}. Save the file, then open it here without map-server requests.`,
        );
      } else this.message(e.data.message);
    };
    const source = this.reader.source;
    worker.postMessage({
      selection: this.selection(),
      snapshot: this.reader.index.manifest.snapshot,
      ...(source instanceof FileSource
        ? { file: source.file }
        : { url: new URL((source as HttpSource).url, location.href).href }),
    });
  }
  private async exportOnServer() {
    this.busy = true;
    this.blob = undefined;
    void this.update();
    const revision = this.revision;
    this.message("Building the offline file on the server…");
    try {
      const blob = await this.operations.offline(this.selection());
      if (revision !== this.revision) return;
      this.blob = blob;
      this.busy = false;
      void this.update();
    } catch (e) {
      if (revision !== this.revision) return;
      this.busy = false;
      await this.update();
      this.message(String(e));
    }
  }
  destroy() {
    this.revision++;
    el("map-tools").hidden = true;
    this.worker?.terminate();
    this.abort.abort();
    this.map.endPicking("offline");
  }
}
