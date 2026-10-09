import type { WorkspaceMap } from "../../../packages/renderer/src/workspace-map";
import {
  type MapFeature,
  type FeatureKind,
  type FeatureResult,
  asPolylines,
} from "../../../packages/features/src/index";
import { OperationSession, executionText } from "./operations";
import { activateTab } from "./tabs";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`extract-${id}`) as T;
export class ExtractControls {
  private result?: FeatureResult;
  private selected = new Set<string>();
  private revision = 0;
  private busy = false;
  private abort = new AbortController();
  constructor(
    readonly map: WorkspaceMap,
    readonly operations: OperationSession,
  ) {
    const select = el<HTMLSelectElement>("kind");
    const kinds = operations.reader.index.manifest.featureKinds;
    for (const option of select.options)
      option.disabled = !!kinds && !kinds.includes(option.value as FeatureKind);
    if (select.selectedOptions[0]?.disabled) select.value = kinds?.[0] ?? "";
    const on = (id: string, fn: () => void) =>
      el(id).addEventListener("click", fn, { signal: this.abort.signal });
    on("load", () => void this.load());
    on("clear", () => this.clear());
    on("select-all", () => {
      this.selected = new Set(this.result?.features.map((f) => f.id));
      this.render();
    });
    on("clear-selection", () => {
      this.selected.clear();
      this.render();
    });
    on("download", () => this.download(false));
    on("lines", () => this.download(true));
    this.map.onFeatureSelect = (id) => {
      activateTab("extract");
      this.toggle(id);
    };
    this.render();
    this.refresh();
  }
  showResult(result: FeatureResult) {
    this.revision++;
    this.result = result;
    this.selected = new Set(result.features.map((f) => f.id));
    this.render();
    el("status").textContent =
      `${result.features.length} tool results. Click objects to select them, then export GeoJSON or polylines.`;
    activateTab("extract");
  }
  refresh() {
    this.revision++;
    this.busy = false;
    const supported =
      this.map.reader.index.manifest.capabilities.includes(
        "feature-extraction",
      );
    el<HTMLButtonElement>("load").disabled =
      !supported || !this.operations.enabled.has("features");
    if (!supported)
      el("status").textContent =
        "This package has no source geometry for extraction.";
    else if (!this.operations.enabled.has("features"))
      el("status").textContent =
        "Enable Feature extraction in Data to use this tool.";
    else
      el("status").textContent =
        "Zoom into an area, then extract its mapped objects.";
  }
  private async load() {
    const revision = ++this.revision;
    this.busy = true;
    el<HTMLButtonElement>("load").disabled = true;
    el("status").textContent =
      `Extracting from the ${this.operations.mode === "server" ? "server" : "package"}…`;
    try {
      const result = await this.operations.query({
        kind: el<HTMLSelectElement>("kind").value as FeatureKind,
        bounds: this.map.viewBounds(),
        limit: Number(el<HTMLSelectElement>("limit").value),
        tag: el<HTMLInputElement>("tag").value.trim(),
      });
      if (revision !== this.revision) return;
      this.result = result;
      this.selected.clear();
      this.render();
      el("status").textContent =
        `${result.features.length} of ${result.matched.toLocaleString()} objects${result.truncated ? " · limit reached; zoom in for more detail" : ""}. ${executionText(result.execution)}.`;
    } catch (e) {
      if (revision === this.revision)
        el("status").textContent = e instanceof Error ? e.message : String(e);
    } finally {
      if (revision === this.revision) {
        this.busy = false;
        el<HTMLButtonElement>("load").disabled =
          !this.operations.enabled.has("features");
      }
    }
  }
  private toggle(id: string) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.render(id);
  }
  private render(active?: string) {
    const features = this.result?.features ?? [];
    this.map.setFeatures(features, this.selected);
    el("selected").textContent =
      `${this.selected.size} of ${features.length} objects selected.`;
    const list = el("results");
    list.replaceChildren();
    for (const f of features) {
      const li = document.createElement("li"),
        button = document.createElement("button"),
        name = document.createElement("span"),
        id = document.createElement("small");
      name.textContent =
        f.properties.name ||
        `${f.properties.tags.building || f.properties.tags.water || f.properties.tags.railway || f.properties.kind}`.replaceAll(
          "_",
          " ",
        );
      id.textContent = f.id;
      button.setAttribute("aria-pressed", String(this.selected.has(f.id)));
      button.append(name, id);
      button.onclick = () => this.toggle(f.id);
      li.append(button);
      list.append(li);
    }
    for (const id of ["download", "lines", "clear-selection"])
      el<HTMLButtonElement>(id).disabled = this.selected.size === 0;
    for (const id of ["select-all", "clear"])
      el<HTMLButtonElement>(id).disabled = features.length === 0;
    const detail = el("detail"),
      f = features.find((f) => f.id === active);
    detail.replaceChildren();
    detail.hidden = !f;
    if (f) {
      const strong = document.createElement("strong");
      strong.textContent = f.properties.name || f.id;
      detail.append(strong);
      for (const [k, v] of Object.entries(f.properties.tags)) {
        const p = document.createElement("div");
        p.textContent = `${k} = ${v}`;
        detail.append(p);
      }
    }
  }
  private download(lines: boolean) {
    if (!this.result || !this.selected.size) return;
    const selected = this.result.features.filter((f) =>
      this.selected.has(f.id),
    );
    const data = {
      ...this.result,
      type: "FeatureCollection",
      features: lines ? asPolylines(selected) : selected,
      snapshot: this.result.snapshot,
      attribution: this.result.attribution,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], {
        type: "application/geo+json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = lines
      ? "selected-polylines.geojson"
      : "selected-features.geojson";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  private clear() {
    this.revision++;
    this.result = undefined;
    this.selected.clear();
    this.render();
    this.refresh();
  }
  destroy() {
    this.revision++;
    this.abort.abort();
    this.map.onFeatureSelect = undefined;
    this.map.setFeatures([], new Set());
  }
}
