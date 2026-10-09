import { unproject } from "../../../packages/format/src/index";
import type {
  CatalogEntry,
  Schema,
} from "../../../packages/operations/src/registry";
import type { FeatureResult } from "../../../packages/features/src/index";
import {
  validatePolygon,
  type Polygon,
} from "../../../packages/offline/src/geometry";
import type { AtlasMap } from "../../../packages/renderer/src/map";
import { OperationSession, executionText } from "./operations";
import type { ExtractControls } from "./extract";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`tools-${id}`) as T;
export class ToolControls {
  private lifetime = new AbortController();
  private active?: AbortController;
  private catalogAbort?: AbortController;
  private entries: CatalogEntry[] = [];
  private readers = new Map<string, () => unknown>();
  private result?: FeatureResult;
  private exportResult?: unknown;
  private drawing = false;
  private revision = 0;
  constructor(
    readonly map: AtlasMap,
    readonly operations: OperationSession,
    readonly extractor: ExtractControls,
  ) {
    const on = (id: string, fn: () => void) =>
      el(id).addEventListener("click", fn, { signal: this.lifetime.signal });
    el("select").addEventListener("change", () => this.form(), {
      signal: this.lifetime.signal,
    });
    on("refresh", () => void this.refresh());
    on("run", () => void this.run(false));
    on("compare", () => void this.run(true));
    on("cancel", () => {
      this.active?.abort();
      this.map.endPicking("tools");
      this.drawing = false;
      this.status("Cancelled.");
    });
    on("show", () => {
      if (this.result) this.extractor.showResult(this.result);
    });
    on("download", () => {
      if (!this.exportResult) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(this.exportResult, null, 2)], {
          type: this.result ? "application/geo+json" : "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `atlas-tool-result.${this.result ? "geojson" : "json"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    void this.refresh();
  }
  private status(message: string) {
    el("status").textContent = message;
  }
  async refresh() {
    const revision = ++this.revision;
    this.active?.abort();
    this.catalogAbort?.abort();
    this.map.endPicking("tools");
    this.drawing = false;
    const controller = (this.catalogAbort = new AbortController());
    this.status("Reading available tools…");
    try {
      this.entries = (await this.operations.catalog(controller.signal)).filter(
        (d) => d.result !== "file",
      );
      if (revision !== this.revision) return;
      const select = el<HTMLSelectElement>("select"),
        previous = select.value;
      select.replaceChildren();
      for (const d of this.entries) {
        const option = new Option(
          `${d.title}${!d.enabled ? " · host disabled" : !d.available ? " · no data" : ""}`,
          d.id,
        );
        select.add(option);
      }
      select.value = this.entries.some((d) => d.id === previous)
        ? previous
        : (this.entries.find((d) => d.implementation !== "atlas-core-1")?.id ??
          this.entries[0]?.id ??
          "");
      this.form();
    } catch (e) {
      if (!controller.signal.aborted) this.status(String(e));
    }
  }
  private descriptor() {
    return this.entries.find(
      (d) => d.id === el<HTMLSelectElement>("select").value,
    );
  }
  private form() {
    this.revision++;
    this.active?.abort();
    this.map.endPicking("tools");
    this.drawing = false;
    this.result = undefined;
    this.exportResult = undefined;
    el("output").textContent = "";
    this.readers.clear();
    el<HTMLButtonElement>("show").disabled = true;
    el<HTMLButtonElement>("download").disabled = true;
    const fields = el("fields");
    fields.replaceChildren();
    const d = this.descriptor();
    if (!d) return;
    el("description").textContent = d.description;
    el("identity").textContent =
      `${d.id} · v${d.version} · ${d.implementation.slice(0, 12)}`;
    el("needs").textContent = d.requirements.length
      ? `Reads ${d.requirements.map((r) => r.family).join(", ")}`
      : `Uses ${d.purposes.join(", ") || "package"} data`;
    for (const [key, schema] of Object.entries<Schema>(
      d.inputSchema.properties ?? {},
    )) {
      const row = document.createElement("div");
      row.className = "plugin-field";
      const label = document.createElement("label");
      label.textContent = schema.title ?? key;
      label.htmlFor = `tool-field-${key}`;
      row.append(label);
      if (schema["x-atlas-widget"] === "polygon") {
        let points: Polygon = [];
        const info = document.createElement("p");
        info.className = "quiet";
        const draw = document.createElement("button"),
          viewport = document.createElement("button"),
          finish = document.createElement("button");
        draw.textContent = "Draw area";
        viewport.textContent = "Use visible area";
        finish.textContent = "Finish area";
        finish.disabled = true;
        const update = () => {
          info.textContent = points.length
            ? `${points.length} corners${this.drawing ? " · click the map, then Finish area or Enter" : " · ready"}`
            : "Choose the visible area or draw a polygon. Maximum 0.25° across.";
          this.map.setSelection(points, !this.drawing);
          finish.disabled = !this.drawing || points.length < 3;
        };
        const complete = () => {
          try {
            validatePolygon(points);
            this.drawing = false;
            this.map.endPicking("tools");
            update();
            this.status("Area ready. Run the tool.");
          } catch (e) {
            this.status(String(e));
          }
        };
        viewport.onclick = () => {
          this.map.endPicking("tools");
          this.drawing = false;
          const [w, s, e, n] = this.map.viewBounds();
          points = [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
          ];
          update();
        };
        draw.onclick = () => {
          points = [];
          this.drawing = true;
          this.map.beginPicking(
            "tools",
            (point) => {
              points.push(point);
              update();
            },
            () => {
              this.drawing = false;
              points = [];
              update();
            },
            "Click corners. Finish area or Enter completes; Escape cancels.",
            complete,
          );
          update();
          this.map.canvas.focus();
        };
        finish.onclick = complete;
        const actions = document.createElement("div");
        actions.className = "plugin-actions";
        actions.append(viewport, draw, finish);
        row.append(actions, info);
        update();
        this.readers.set(key, () => {
          if (this.drawing) throw new Error("Finish the drawn area first.");
          validatePolygon(points);
          return structuredClone(points);
        });
      } else {
        let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (schema.enum) {
          const select = document.createElement("select");
          for (const v of schema.enum)
            select.add(new Option(String(v), String(v)));
          input = select;
        } else if (schema.type === "array" || schema.type === "object") {
          input = document.createElement("textarea");
          input.rows = 3;
        } else {
          input = document.createElement("input");
          input.type =
            schema.type === "integer" || schema.type === "number"
              ? "number"
              : "text";
          if (schema.minimum !== undefined) input.min = String(schema.minimum);
          if (schema.maximum !== undefined) input.max = String(schema.maximum);
        }
        input.id = label.htmlFor;
        const defaultValue =
          schema.default ??
          (key === "bounds"
            ? this.map.viewBounds()
            : key === "point" || key === "start" || key === "end"
              ? unproject(...this.map.center)
              : key === "bands"
                ? [300, 600, 900]
                : undefined);
        if (defaultValue !== undefined)
          input.value =
            typeof defaultValue === "object"
              ? JSON.stringify(defaultValue)
              : String(defaultValue);
        row.append(input);
        this.readers.set(key, () => {
          if (!input.value.trim() && !d.inputSchema.required?.includes(key))
            return undefined;
          return schema.type === "integer" || schema.type === "number"
            ? Number(input.value)
            : schema.type === "array" ||
                schema.type === "object" ||
                schema.type === "boolean"
              ? JSON.parse(input.value)
              : input.value;
        });
      }
      fields.append(row);
    }
    const permitted =
      d.available &&
      d.enabled &&
      d.purposes.every((p) => this.operations.enabled.has(p as any));
    el<HTMLButtonElement>("run").disabled = !permitted;
    el<HTMLButtonElement>("compare").disabled =
      !permitted || !this.operations.remote;
    this.status(
      !d.enabled
        ? "The host has disabled this operation. Device tools remain independently available."
        : !d.available
          ? "This package lacks the required data."
          : !permitted
            ? "Enable the required purpose in Data settings."
            : `Ready on ${this.operations.mode === "server" ? "the server" : "this device"}.`,
    );
  }
  private async run(compare: boolean) {
    this.active?.abort();
    const controller = (this.active = new AbortController()),
      revision = ++this.revision;
    const d = this.descriptor();
    if (!d) return;
    el<HTMLButtonElement>("run").disabled = true;
    el<HTMLButtonElement>("compare").disabled = true;
    this.status(
      compare
        ? "Comparing the same tool on device and server…"
        : "Running tool…",
    );
    const originalMode = this.operations.mode;
    try {
      const input = Object.fromEntries(
        [...this.readers]
          .map(([k, read]) => [k, read()])
          .filter(([, v]) => v !== undefined),
      );
      let response;
      if (compare) {
        // Execution override is per invocation; the user's global setting is unchanged.
        const device = await this.operations.invokePlugin(
          d,
          input,
          controller.signal,
          (message) => this.status(message),
          "device",
        );
        const server = await this.operations.invokePlugin(
          d,
          input,
          controller.signal,
          (message) => this.status(message),
          "server",
        );
        response = device;
        this.status(
          `${JSON.stringify(device.result) === JSON.stringify(server.result) ? "MATCH" : "DIFFERENT"} · ${executionText(device.execution)} · ${executionText(server.execution)}`,
        );
      } else {
        response = await this.operations.invokePlugin(
          d,
          input,
          controller.signal,
          (message) => this.status(message),
          originalMode,
        );
        this.status(executionText(response.execution));
      }
      if (revision !== this.revision || controller.signal.aborted) return;
      const result = response.result as any;
      this.result =
        result?.type === "FeatureCollection"
          ? { ...result, provenance: response.provenance }
          : undefined;
      this.exportResult = this.result ?? response;
      const output = el("output");
      output.replaceChildren();
      if (this.result) {
        const summary = document.createElement("p");
        summary.textContent = `${this.result.features.length} of ${this.result.matched} matching objects`;
        output.append(summary);
        if (result.analysis?.coverage) {
          const coverage = document.createElement("p");
          coverage.className = "quiet";
          coverage.textContent = `${result.analysis.coverage}${result.analysis.unclassifiedWater ? ` ${result.analysis.unclassifiedWater} water objects have unknown classification.` : ""}`;
          output.append(coverage);
        }
        for (const f of this.result.features) {
          const p = document.createElement("p");
          p.className = "plugin-result";
          p.textContent = `${f.properties.tags["atlas:rank"] ? f.properties.tags["atlas:rank"] + ". " : ""}${f.properties.name || f.id}${f.properties.tags["atlas:area_m2"] ? " · " + (Number(f.properties.tags["atlas:area_m2"]) / 1e6).toFixed(3) + " km²" : ""}`;
          output.append(p);
        }
      }
      const detail = document.createElement("details"),
        summary = document.createElement("summary"),
        pre = document.createElement("pre");
      summary.textContent = "Result & provenance";
      pre.textContent = JSON.stringify(
        this.result
          ? {
              ...response,
              result: {
                ...result,
                features: `${result.features.length} GeoJSON objects (included in download)`,
              },
            }
          : response,
        null,
        2,
      );
      detail.append(summary, pre);
      output.append(detail);
      el<HTMLButtonElement>("show").disabled = !this.result?.features.length;
      el<HTMLButtonElement>("download").disabled = false;
    } catch (e) {
      if (revision === this.revision)
        this.status(
          controller.signal.aborted
            ? "Cancelled."
            : e instanceof Error
              ? e.message
              : String(e),
        );
    } finally {
      if (revision === this.revision) {
        el<HTMLButtonElement>("run").disabled = false;
        el<HTMLButtonElement>("compare").disabled = !this.operations.remote;
      }
    }
  }
  destroy() {
    this.revision++;
    this.lifetime.abort();
    this.active?.abort();
    this.catalogAbort?.abort();
    this.map.endPicking("tools");
  }
}
