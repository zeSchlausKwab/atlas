import { openRasterAmendment } from "./host-raster-amend";
import { capabilityPanel } from "./host-capabilities";
import { AtlasReader, HttpSource } from "../../../packages/format/src/reader";
import { objectCatalog } from "../../../packages/objects/src/index";
import { publishMap } from "./host-discovery";
import {
  currentObservation,
  type CompilerObservation,
} from "../../../packages/provisioning/src/compiler-observation";
import { approximateDuration } from "../../../packages/provisioning/src/compiler-progress";
import { project } from "../../../packages/format/src/index";
import { openClient } from "./client-link";
import { storageSize } from "./host-budget";
import { storageRequest } from "./host-storage";
import {
  hostPreparationSpace,
  NO_SIZE_LIMIT,
  type StorageInfo,
} from "../../../packages/provisioning/src/capacity";
import { createPreview, type HostPreview } from "./host-preview";
import {
  validatePolygon,
  type Polygon,
} from "../../../packages/offline/src/geometry";
import type {
  Manifest,
  MapLayer,
  TransportMode,
} from "../../../packages/format/src/index";
import type { FeatureKind } from "../../../packages/features/src/index";
import type { PbfPlan } from "../../../packages/provisioning/src/global-source";
import type { SelectionScope } from "../../../packages/provisioning/src/selection";
import type { PackageSelection } from "../../../packages/provisioning/src/selection";
import type { PreparationJob } from "../../server/preparations";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`prepare-${id}`) as T;
const bytes = (n: number) => (n / 1024 / 1024).toFixed(2) + " MiB";
const text = (tag: string, value: string, cls?: string) => {
  const e = document.createElement(tag);
  e.textContent = value;
  if (cls) e.className = cls;
  return e;
};
let baseSourceBytes = 0;
let source: Manifest,
  preview: HostPreview | undefined,
  points: Polygon = [],
  closed = false,
  mode: "rect" | "polygon" | null = null,
  loading = false;
let installedScope: SelectionScope,
  globalScope: SelectionScope,
  sourcePlan: PbfPlan | undefined;
let storage: StorageInfo | undefined;
type CachedChoice = {
  id: string;
  name: string;
  kind: string;
  bytes: number;
  sha256?: string;
};
type AtlasChoice = {
  id: string;
  manifest: Manifest;
  available: SelectionScope["available"];
  bytes?: number;
};
let oceanSource: { url: string; sha256: string } | undefined;
let cachedSources: CachedChoice[] = [],
  atlasSources: AtlasChoice[] = [];
let activeBuild = false,
  compilerReady = false,
  initialized = false;
const sourceKind = () =>
  document.querySelector<HTMLInputElement>(
    'input[name="build-source-kind"]:checked',
  )!.value;
const sourceValue = () => el<HTMLSelectElement>("data-source").value;
const atlasSource = () =>
  atlasSources.find((s) => `atlas:${s.id}` === sourceValue());
const cachedSource = () =>
  cachedSources.find((s) => `cached:${s.id}` === sourceValue());
const selectedManifest = () => atlasSource()?.manifest ?? source;
function populateSources() {
  const select = el<HTMLSelectElement>("data-source"),
    saved = select.value;
  select.replaceChildren();
  if (cached()) {
    for (const item of [...cachedSources].sort(
      (a, b) => Number(b.kind === "planet") - Number(a.kind === "planet"),
    ))
      select.append(
        new Option(
          `${item.name} · ${storageSize(item.bytes)}`,
          `cached:${item.id}`,
        ),
      );
    if (!cachedSources.length)
      select.append(new Option("No verified PBF available yet", ""));
  } else if (remotePbf())
    select.append(new Option("Find a covering Geofabrik region", "global"));
  else {
    select.append(
      new Option(`${source?.name ?? "Installed map"} · installed`, "installed"),
    );
    for (const item of atlasSources)
      select.append(new Option(item.manifest.name, `atlas:${item.id}`));
  }
  if ([...select.options].some((o) => o.value === saved)) select.value = saved;
  el("source-select-label").hidden = remotePbf();
  el("source-select-title").textContent = cached()
    ? "Verified PBF file"
    : "Atlas dataset";
}
const sourceReady = () =>
  global()
    ? compilerReady && (!cached() || !!cachedSource())
    : sourceValue() === "installed" || !!atlasSource();
function largeSelection() {
  if (points.length < 3) return false;
  const p = points.map(([x, y]) => project(x, y));
  const xs = p.map((v) => Math.floor(v[0] * 512)),
    ys = p.map((v) => Math.floor(v[1] * 512));
  return (
    (Math.max(...xs) - Math.min(...xs) + 1) *
      (Math.max(...ys) - Math.min(...ys) + 1) >
    16
  );
}
function spaceNeeded() {
  return hostPreparationSpace(NO_SIZE_LIMIT, {
    cached: cached(),
    partitioned: largeSelection(),
    sourceBytes: remotePbf() ? sourcePlan?.bytes : undefined,
    atlasBytes: atlasSource()?.bytes ?? baseSourceBytes,
  });
}
function renderStorage() {
  const available = storage?.availableBytes;
  el("storage-meter").hidden = available === undefined;
  if (available !== undefined) {
    el("storage-free").textContent =
      `${storageSize(available)} available of ${storageSize(storage!.totalBytes)}`;
    const meter = el<HTMLMeterElement>("storage-meter");
    meter.max = storage!.totalBytes || 1;
    meter.value = available;
  }
  const estimate = el("storage-estimate");
  estimate.dataset.insufficient = "false";
  if (!closed || (remotePbf() && !sourcePlan)) {
    estimate.textContent = remotePbf()
      ? "Choose an area and find its covering download to check the source size."
      : "Choose an area and capabilities. The finished file size depends on the selected data.";
    return;
  }
  const needed = spaceNeeded(),
    risk = available !== undefined && needed > available;
  estimate.dataset.insufficient = String(risk);
  estimate.textContent = `${remotePbf() ? `${storageSize(sourcePlan!.bytes)} source PBF · ` : ""}${storageSize(needed)} rough planning allowance for temporary files, output and free-space reserve. Actual use may be higher or lower.${risk ? " This might exceed free space. You can review the warning and start anyway." : ""}`;
}
let checking = false,
  submitting = false,
  planKey = "";
const global = () => sourceKind() !== "atlas";
const cached = () => sourceKind() === "cached";
const remotePbf = () => sourceKind() === "geofabrik";
const scope = (): SelectionScope => {
  if (global()) return globalScope;
  const atlas = atlasSource();
  return atlas
    ? { ...atlas.manifest, available: atlas.available }
    : installedScope;
};
const sourceArea = () => ({
  polygon: points,
  paddingCells: Number(el<HTMLSelectElement>("padding").value),
  profiles: selection().profiles,
  maxSourceBytes: NO_SIZE_LIMIT,
});
const sourceKey = () => {
  const a = sourceArea();
  return JSON.stringify({ ...a, profiles: !!a.profiles.length });
};
const fields = new Map<string, HTMLInputElement>();
function checked(k: string) {
  return fields.get(k)?.checked ?? false;
}
function checkbox(
  group: string,
  key: string,
  label: string,
  enabled: boolean,
  on: boolean,
) {
  const row = document.createElement("label"),
    input = document.createElement("input");
  input.type = "checkbox";
  input.disabled = !enabled;
  input.checked = enabled && on;
  fields.set(key, input);
  input.onchange = () => {
    el<HTMLSelectElement>("preset").value = "custom";
    update();
  };
  row.append(input, text("span", label));
  el(group).append(row);
}
function update() {
  preview?.selection(points, closed);
  preview?.picking(!!mode);
  el<HTMLButtonElement>("finish").disabled =
    mode !== "polygon" || points.length < 3;
  el<HTMLButtonElement>("undo").disabled = !points.length;
  if (
    sourcePlan &&
    (planKey !== sourceKey() || sourcePlan.expiresAt <= Date.now())
  ) {
    sourcePlan = undefined;
    el("source-plan").textContent =
      "Selection changed or source plan expired. Check the PBF source again.";
  }
  el<HTMLButtonElement>("check-source").disabled = !closed || checking;
  el<HTMLButtonElement>("submit").disabled =
    !closed || submitting || !sourceReady() || (remotePbf() && !sourcePlan);
  el("submit").textContent = submitting
    ? "Starting…"
    : activeBuild
      ? "Add to build queue ↗"
      : cached()
        ? "Build & host map ↗"
        : remotePbf()
          ? "Download, build & host ↗"
          : "Prepare & host map ↗";
  if (initialized) {
    const s = selection();
    el("routing-summary").textContent =
      `Routing & isochrones · ${s.profiles.length ? s.profiles.join(", ") : "off"}`;
    const queries = [
      s.search && "search",
      s.reverse && "nearest street",
      s.peaks && "peak queries",
    ].filter(Boolean);
    el("search-summary").textContent =
      `Search & queries · ${queries.length ? queries.join(", ") : "off"}`;
    el("extract-summary").textContent =
      `Selectable source features · ${s.featureKinds.length ? s.featureKinds.join(", ") : "off"}`;
    el("preset-note").textContent =
      {
        view: "Geometry and labels for display. Routing, search and feature extraction stay off.",
        geometry: "Display geometry only, without labels or query indexes.",
        analysis:
          "Tagged source objects, relationships, administrative areas and search. Independent of display categories; rendered map layers are optional.",
        "water-buildings":
          "Just water and building geometry, including available building heights.",
        all: "Every capability available in this source, including all travel modes, search and selectable features.",
        custom: "Your individual choices below define the package.",
      }[el<HTMLSelectElement>("preset").value] ?? "";
    el("summary").textContent = !sourceReady()
      ? "Choose an available source to continue."
      : !closed
        ? global()
          ? "Draw an area or use the Britain rectangle, then choose its capabilities."
          : "Draw an area inside the selected Atlas map, then choose its capabilities."
        : `${cached() ? cachedSource()!.name : remotePbf() ? (sourcePlan?.region.name ?? "Geofabrik") : selectedManifest().name} → ${s.name || "Untitled map"} · z${s.minZoom}–${s.maxZoom} · ${s.layers.length} geometry layers · ${s.profiles.length ? s.profiles.join(" / ") + " routing" : "routing off"} · ${queries.length ? queries.join(" / ") : "search & queries off"} · ${s.featureKinds.length} selectable feature types.`;
  }
  el("area").textContent = closed
    ? `${points.length} corners · area ready`
    : mode === "rect"
      ? `Click ${points.length ? "the opposite" : "the first"} corner of your rectangle.`
      : mode === "polygon"
        ? `${points.length} corners · click to add, then Finish polygon.`
        : "Choose Rectangle or Polygon to draw an area.";
  renderStorage();
  for (const k of ["rect", "polygon"])
    el(k).setAttribute("aria-pressed", String(mode === k));
}
function finish() {
  try {
    validatePolygon(points);
    closed = true;
    mode = null;
    update();
    el("message").textContent = cached()
      ? "Area ready. Choose capabilities, then build from the verified PBF already on this server."
      : global()
        ? "Area ready. Choose the data to keep, then check the PBF source."
        : "Area ready. Choose the data to keep, then prepare your map.";
  } catch (e) {
    if (mode === "rect") {
      points = points.slice(0, 1);
      update();
    }
    el("message").textContent = String(e);
  }
}
function clear() {
  points = [];
  mode = null;
  closed = false;
  update();
  el("message").textContent = global()
    ? "Draw an area or use the Britain rectangle. Choose capabilities before starting."
    : "Draw an area within this Atlas map. Only its available data can be included.";
}
function pick(p: [number, number]) {
  if (!mode) return;
  const source = scope();
  if (
    p[0] < source.bounds[0] ||
    p[0] > source.bounds[2] ||
    p[1] < source.bounds[1] ||
    p[1] > source.bounds[3]
  ) {
    el("message").textContent =
      "Choose a point inside the source bounds. The world preview is separate from available source data.";
    return;
  }
  if (mode === "rect" && points.length === 1) {
    const a = points[0]!;
    points = [
      [Math.min(a[0], p[0]), Math.min(a[1], p[1])],
      [Math.max(a[0], p[0]), Math.min(a[1], p[1])],
      [Math.max(a[0], p[0]), Math.max(a[1], p[1])],
      [Math.min(a[0], p[0]), Math.max(a[1], p[1])],
    ];
    finish();
  } else if (points.length < 128) {
    points.push(p);
    update();
  }
}
async function switchPreview() {
  const select = el<HTMLSelectElement>("provider");
  select.disabled = true;
  preview?.destroy();
  preview = undefined;
  el("preview-status").textContent = "Loading preview…";
  try {
    preview = await createPreview(
      el("map"),
      select.value,
      scope().bounds,
      pick,
      finish,
      () => {
        mode = null;
        update();
      },
      (s) => (el("preview-status").textContent = s),
      global(),
      atlasSource() ? `/maps/${atlasSource()!.id}.atlas` : "/maps/demo.atlas",
    );
    if (closed) {
      const xs = points.map((p) => p[0]),
        ys = points.map((p) => p[1]);
      preview.fitArea([
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ]);
    }
    update();
  } catch (e) {
    el("preview-status").textContent =
      `Preview unavailable: ${String(e)}. Try the other preview.`;
  } finally {
    select.disabled = false;
  }
}
function selection(): PackageSelection {
  return {
    ...(sourceValue().startsWith("cached:") && oceanSource && checked("ocean")
      ? { ocean: { sha256: oceanSource.sha256 } }
      : {}),
    snapshot: scope().snapshot,
    name: el<HTMLInputElement>("name").value,
    polygon: points,
    minZoom: Number(el<HTMLInputElement>("min").value),
    maxZoom: Number(el<HTMLInputElement>("max").value),
    layers: ["land", "water", "roads", "railways", "buildings", "peaks"].filter(
      (k) => checked(`layer-${k}`),
    ) as MapLayer[],
    placeNames: checked("places"),
    streetNames: checked("streets"),
    pois: checked("pois"),
    profiles: ["walking", "cycling", "driving"].filter((k) =>
      checked(`profile-${k}`),
    ) as TransportMode[],
    search: checked("search"),
    reverse: checked("reverse"),
    peaks: checked("query-peaks"),
    featureKinds: [
      "water",
      "buildings",
      "railways",
      "roads",
      "land",
      "boundaries",
      "objects",
    ].filter((k) => checked(`feature-${k}`)) as FeatureKind[],
    paddingCells: Number(el<HTMLSelectElement>("padding").value),
    maxBytes: NO_SIZE_LIMIT,
  };
}
const request = storageRequest;
const composition = new Set<string>();
function updateComposition() {
  el<HTMLAnchorElement>("compose").href = openClient(
    composition.size ? { maps: [...composition] } : {},
  );
  el("compose").textContent = composition.size
    ? `Compose ${composition.size} selected maps ↗`
    : "Compose hosted maps ↗";
  el("compose-count").textContent = composition.size
    ? "These sources will share one map view."
    : "Choose maps below, or open the full library.";
}
let lastJobs = "";
let observations = new Map<string, CompilerObservation>();
let nextObservationRead = 0;
function jobs(values: PreparationJob[]) {
  const views = new Map<string, CompilerObservation>();
  values = values.map((job) => {
    const view = currentObservation(observations.get(job.id), job);
    if (!view) return job;
    views.set(job.id, view);
    return { ...job, progress: view.progress };
  });
  activeBuild = values.some((j) => ["running", "cancelling"].includes(j.state));
  for (const id of composition)
    if (
      !values.some(
        (j) => j.id === id && j.state === "ready" && j.served !== false,
      )
    )
      composition.delete(id);
  updateComposition();
  const identity = JSON.stringify([values, cachedSources]);
  if (identity === lastJobs) return;
  lastJobs = identity;
  const list = el("jobs"),
    library = el("library");
  list.replaceChildren();
  library.replaceChildren();
  for (const job of values) {
    const card = text("article", "", "preparation-card"),
      heading = text("div", "", "preparation-card-heading");
    heading.append(
      text("h3", job.name),
      text(
        "span",
        job.state === "ready" && job.served === false ? "retained" : job.state,
        "state-badge",
      ),
    );
    card.append(heading);
    if (job.state === "ready" && job.manifest) {
      const m = job.manifest;
      if (job.sourcePlan)
        card.append(
          text(
            "p",
            `OSM source: ${job.sourcePlan.region.name} · ${bytes(job.sourcePlan.bytes)} PBF`,
            "quiet",
          ),
        );
      card.append(
        text(
          "p",
          `${bytes(job.size!)} · z${m.minZoom}–${m.maxZoom} · ${[...(m.tileLayers ?? []), ...(m.rasters ?? []).map((r) => r.name)].join(", ") || "no display geometry"}`,
        ),
        text("p", m.capabilities.join(" · "), "quiet"),
      );
      const links = document.createElement("div");
      links.className = "host-actions";
      for (const [label, url] of [
        ["Open in client ↗", openClient({ map: job.id })],
        ["Download .atlas", `/maps/${job.id}.atlas`],
        ["Capabilities ↗", `/maps/${job.id}/api/capabilities`],
      ]) {
        const a = document.createElement("a");
        a.href = url!;
        a.textContent = label!;
        if (label!.startsWith("Download")) a.download = job.name + ".atlas";
        else {
          a.target = "_blank";
          a.rel = "noopener";
        }
        links.append(a);
      }
      if (m.capabilities.includes("source-objects")) {
        const report = document.createElement("details");
        report.append(text("summary", "Source retention report"));
        let loaded = false;
        report.ontoggle = () => {
          if (!report.open || loaded) return;
          loaded = true;
          const body = text("p", "Reading report…", "quiet");
          report.append(body);
          void (async () => {
            const reader = new AtlasReader(
              new HttpSource(`/maps/${job.id}.atlas`),
            );
            try {
              await reader.open();
              const c = await objectCatalog(reader);
              body.textContent = `${c.count.toLocaleString()} retained objects · ${Object.entries(
                c.report.counts,
              )
                .map(([k, n]) => `${n.toLocaleString()} ${k}`)
                .join(" · ")}. Source completeness: unknown.`;
              report.append(text("pre", JSON.stringify(c.report, null, 2)));
            } catch (e) {
              body.textContent = String(e);
            } finally {
              reader.dispose();
            }
          })();
        };
        card.append(report);
      }
      const publish = document.createElement("button");
      publish.textContent = "Publish with Hashtree";
      publish.onclick = () => void publishMap(job.id);
      links.append(publish);
      const details = document.createElement("details");
      details.append(
        text("summary", "Package manifest"),
        text("pre", JSON.stringify(m, null, 2)),
      );
      const select = document.createElement("label"),
        check = document.createElement("input");
      select.className = "host-compose-select";
      check.type = "checkbox";
      check.checked = composition.has(job.id);
      check.onchange = () => {
        if (check.checked) composition.add(job.id);
        else composition.delete(job.id);
        updateComposition();
      };
      select.append(check, text("span", `Compose ${job.name}`));
      const actions = text("div", "", "host-actions host-card-actions");
      const reuse = text("button", "Use as source") as HTMLButtonElement;
      reuse.hidden = !!job.imageImport || !job.manifest.tileLayers?.length;
      reuse.onclick = () => void chooseSource("atlas", `atlas:${job.id}`);
      const serve = text(
        "button",
        job.served === false ? "Serve this revision again" : "Stop serving",
      ) as HTMLButtonElement;
      serve.onclick = async () => {
        serve.disabled = true;
        try {
          await request("/admin/preparations/serve", {
            id: job.id,
            served: job.served === false,
          });
          await refresh();
        } catch (e) {
          serve.disabled = false;
          serve.textContent = String(e);
        }
      };
      const imagery = text("button", "Manage imagery") as HTMLButtonElement;
      imagery.onclick = () =>
        openRasterAmendment(
          job,
          [
            { id: "demo", manifest: source! },
            ...values
              .filter((j) => j.state === "ready" && j.manifest)
              .map((j) => ({ id: j.id, manifest: j.manifest! })),
          ],
          refresh,
        );
      actions.append(reuse, imagery, serve, deleteButton(job));
      if (job.served === false) {
        links.replaceChildren();
        card.append(
          text(
            "p",
            job.supersededBy
              ? "Replaced by a newer revision. File retained locally; no longer advertised or served."
              : "Not served. File retained locally.",
            "quiet",
          ),
        );
        check.disabled = true;
      }
      card.append(
        links,
        capabilityPanel(job, cachedSources, refresh),
        details,
        select,
        actions,
      );
      library.append(card);
    } else {
      if (["failed", "cancelled"].includes(job.state)) {
        const resume = text(
          "button",
          job.cachedSource || job.imageImport || job.archiveImport
            ? "Resume saved build"
            : "Queue again",
        ) as HTMLButtonElement;
        resume.onclick = async () => {
          resume.disabled = true;
          try {
            await request(`/admin/preparations/${job.id}/resume`, {});
            await refresh();
          } catch (e) {
            el("message").textContent = String(e);
            resume.disabled = false;
          }
        };
        card.append(resume);
      }
      card.append(text("p", job.error ?? job.progress.message));
      const view = views.get(job.id);
      if (view) {
        const stages = text("ol", "", "build-stage-list");
        for (const stage of view.stages) {
          const item = text(
            "li",
            `${stage.state === "done" ? "✓" : stage.state === "active" ? "●" : "○"} ${stage.label}`,
          );
          item.dataset.state = stage.state;
          stages.append(item);
        }
        card.append(stages);
      }
      if (job.state === "running" || job.state === "cancelling") {
        const progress = document.createElement("progress");
        progress.max =
          job.progress.stagePercent !== undefined
            ? 100
            : job.progress.total || 1;
        if (job.progress.stagePercent !== undefined)
          progress.value = job.progress.stagePercent;
        else if (job.progress.total) progress.value = job.progress.completed;
        progress.setAttribute("aria-label", `Preparing ${job.name}`);
        card.append(
          progress,
          text(
            "p",
            `${job.progress.phase}${job.progress.total ? " · " + (job.progress.unit === "bytes" ? `${bytes(job.progress.completed)} / ${bytes(job.progress.total)}` : `${job.progress.completed.toLocaleString()} / ${job.progress.total.toLocaleString()} ${job.progress.unit ?? "blocks"}`) : ""} · ${bytes(job.progress.writtenBytes)} ${job.cachedSource ? "saved stage data" : "Atlas written"}`,
            "quiet",
          ),
        );
        if (job.progress.stage) {
          const p = job.progress;
          card.append(
            text(
              "p",
              `${p.stageIndex ? `Routing stage ${p.stageIndex} of ${p.stageCount} · ` : ""}${p.stagePercent !== undefined ? `${p.stagePercent.toFixed(1)}% of this pass · ` : ""}${p.etaSeconds !== undefined ? `Approximately ${approximateDuration(p.etaSeconds)} left in this stage` : p.total ? "Estimating remaining time from throughput…" : "Working · this step has no reliable total yet"}`,
              "quiet",
            ),
          );
          if (p.checkpointAt)
            card.append(
              text(
                "p",
                `Checkpoint saved ${new Date(p.checkpointAt).toLocaleTimeString()} · Resume continues from the last committed batch.`,
                "quiet",
              ),
            );
          card.append(
            text(
              "p",
              "Percentage and ETA apply to this pass only. Later passes have different costs; a reliable whole-build ETA is not available yet.",
              "quiet",
            ),
          );
        }
        const cancel = text(
          "button",
          job.state === "cancelling"
            ? "Stopping…"
            : job.cachedSource || job.imageImport || job.archiveImport
              ? "Stop & keep checkpoints"
              : "Cancel preparation",
        ) as HTMLButtonElement;
        cancel.disabled = job.state === "cancelling";
        cancel.onclick = async () => {
          cancel.disabled = true;
          try {
            await request(`/admin/preparations/${job.id}/cancel`, {});
            await refresh();
          } catch (e) {
            el("message").textContent = String(e);
            cancel.disabled = false;
          }
        };
        card.append(cancel);
      }
      if (job.state === "queued") {
        const cancel = text("button", "Remove from queue") as HTMLButtonElement;
        cancel.onclick = async () => {
          cancel.disabled = true;
          try {
            await request(`/admin/preparations/${job.id}/cancel`, {});
            await refresh();
          } catch (e) {
            el("message").textContent = String(e);
            cancel.disabled = false;
          }
        };
        card.append(cancel);
      }
      if (["cancelled", "failed", "deleting"].includes(job.state))
        card.append(deleteButton(job));
      list.append(card);
    }
  }
  if (!list.children.length)
    list.append(
      text(
        "p",
        "No queued or running preparations. Add several areas; builds run one at a time and continue when you leave this page.",
        "quiet",
      ),
    );
  if (!library.children.length)
    library.append(
      text(
        "p",
        "Your prepared excerpts will appear here, ready to serve and download.",
        "quiet",
      ),
    );
  el("library-count").textContent = String(
    values.filter((j) => j.state === "ready").length,
  ).padStart(2, "0");
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const r = await fetch("/admin/preparations");
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    // An optional read-only bridge can observe a compiler started before structured progress existed.
    // Its absence is normal; a stale bridge never replaces the server's current job state.
    if (
      Date.now() >= nextObservationRead &&
      data.jobs.some((j: PreparationJob) => j.state === "running")
    ) {
      nextObservationRead = Date.now() + 15000;
      try {
        const r = await fetch("/compiler-progress.json", {
          signal: AbortSignal.timeout(2500),
        });
        if (r.status === 404) nextObservationRead = Date.now() + 60000;
        if (r.ok) {
          const value = await r.json();
          if (value.schema === 1 && Array.isArray(value.observations))
            observations = new Map(
              value.observations.map((v: CompilerObservation) => [v.id, v]),
            );
        }
      } catch {
        /* Native job progress remains available. */
      }
    }
    baseSourceBytes = data.sourceBytes ?? 0;
    const identity = JSON.stringify([cachedSources, atlasSources]);
    oceanSource = data.oceanSource ?? undefined;
    cachedSources = data.cachedSources ?? [];
    atlasSources = data.atlasSources ?? [];
    jobs(data.jobs);
    compilerReady = data.globalSource.ready;
    if (identity !== JSON.stringify([cachedSources, atlasSources])) {
      const previous = sourceValue();
      populateSources();
      if (initialized && sourceValue() !== previous) {
        configureSource();
        void switchPreview();
      }
    }
    storage =
      typeof data.storage?.availableBytes === "number"
        ? data.storage
        : undefined;
    if (!storage)
      el("storage-free").textContent =
        "Server disk information is unavailable. Preparation will check again before starting.";
    renderStorage();
    return data;
  } catch (e) {
    el("message").textContent = String(e);
  } finally {
    loading = false;
  }
}
function configureSource() {
  const current = scope(),
    a = current.available;
  for (const k of ["layers", "labels", "profiles", "queries", "features"])
    for (const row of el(k).querySelectorAll("label")) row.remove();
  fields.clear();
  el("source").textContent = cached()
    ? (cachedSource()?.name ?? "No verified PBF yet")
    : remotePbf()
      ? "Geofabrik regional download"
      : selectedManifest().name;
  el("source-note").textContent = cached()
    ? "Extract any area covered by this file. The planet covers the world; a regional PBF only covers its region. No download is needed. Larger builds use disk-backed, resumable stages."
    : remotePbf()
      ? "Draw your area. We find and download one covering regional PBF, then crop and compile it on this server."
      : "Create a smaller package from this Atlas map. Only its existing area, zoom levels and capabilities are available; missing data cannot be added.";
  if (global() && !compilerReady)
    el("source-note").textContent +=
      " PBF tools (Osmium and Cargo) are unavailable on this server.";
  el<HTMLInputElement>("name").value = global()
    ? "My OSM excerpt"
    : `${selectedManifest().name} excerpt`;
  for (const k of ["min", "max"]) {
    const input = el<HTMLInputElement>(k);
    input.min = String(current.minZoom);
    input.max = String(current.maxZoom);
    input.value = String(k === "min" ? current.minZoom : current.maxZoom);
  }
  for (const [k, label] of [
    ["land", "Landscape"],
    ["water", "Water"],
    ["roads", "Roads & paths"],
    ["railways", "Railways"],
    ["buildings", "Buildings & heights"],
    ["peaks", "Mountain geometry"],
  ])
    checkbox(
      "layers",
      `layer-${k}`,
      label!,
      a.layers.includes(k as MapLayer),
      true,
    );
  checkbox(
    "layers",
    "ocean",
    "Sea polygons · separate coastline snapshot",
    !!oceanSource && sourceValue().startsWith("cached:"),
    true,
  );
  for (const [k, label] of [
    ["places", "Cities & villages"],
    ["streets", "Street names"],
    ["pois", "POI labels"],
  ])
    checkbox("labels", k!, label!, a.labels, true);
  for (const [k, label] of [
    ["walking", "Walking"],
    ["cycling", "Cycling"],
    ["driving", "Driving"],
  ])
    checkbox(
      "profiles",
      `profile-${k}`,
      label!,
      a.profiles.includes(k as TransportMode),
      false,
    );
  checkbox("queries", "search", "Location search", a.search, false);
  checkbox(
    "queries",
    "reverse",
    "Nearest street / reverse geocoding",
    a.reverse,
    false,
  );
  checkbox("queries", "query-peaks", "Peak queries", a.peaks, false);
  for (const [k, label] of [
    ["water", "Lakes & water"],
    ["buildings", "Buildings"],
    ["railways", "Railways"],
    ["roads", "Roads & paths"],
    ["land", "Landscape"],
    [
      "objects",
      "Analysis source · tagged objects, site outlines, coasts & relationships",
    ],
    [
      "boundaries",
      "Administrative areas · countries, municipalities & districts",
    ],
  ])
    checkbox(
      "features",
      `feature-${k}`,
      label!,
      a.featureKinds.includes(k as FeatureKind),
      false,
    );
  el("global-controls").hidden = !remotePbf();
  el("britain").hidden = !global();
  el("fit").textContent = global() ? "Fit world" : "Fit source";
  const local = el<HTMLSelectElement>(
    "provider",
  ).querySelector<HTMLOptionElement>('option[value="local"]')!;
  local.disabled = global();
  if (global()) el<HTMLSelectElement>("provider").value = "openfreemap";
  el<HTMLSelectElement>("preset").value = "view";
  sourcePlan = undefined;
  el("source-plan").textContent = "Draw an area to find its source.";
  clear();
}
async function chooseSource(kind: string, value: string) {
  await refresh();
  document.querySelector<HTMLInputElement>(
    `input[name="build-source-kind"][value="${kind}"]`,
  )!.checked = true;
  populateSources();
  const select = el<HTMLSelectElement>("data-source");
  if (![...select.options].some((o) => o.value === value)) {
    configureSource();
    el("message").textContent = "This source is no longer available.";
    return;
  }
  select.value = value;
  configureSource();
  await switchPreview();
  document.getElementById("prepare")!.scrollIntoView({ behavior: "smooth" });
}
function deleteButton(job: PreparationJob) {
  const button = text(
    "button",
    job.state === "ready" ? "Delete dataset…" : "Delete build…",
    "host-danger",
  ) as HTMLButtonElement;
  button.onclick = () => {
    pendingDelete = job;
    document.getElementById("dataset-delete-description")!.textContent =
      `${job.name}${job.size ? " · " + storageSize(job.size) : " · saved build and checkpoints"}`;
    document.getElementById("dataset-delete-error")!.textContent = "";
    (
      document.getElementById("dataset-delete-dialog") as HTMLDialogElement
    ).showModal();
  };
  return button;
}
let pendingDelete: PreparationJob | undefined;
function setupDeletion() {
  const dialog = document.getElementById(
    "dataset-delete-dialog",
  ) as HTMLDialogElement;
  const button = document.getElementById(
    "dataset-delete-confirm",
  ) as HTMLButtonElement;
  button.onclick = async () => {
    if (!pendingDelete) return;
    const job = pendingDelete;
    button.disabled = true;
    try {
      await request(`/admin/preparations/${job.id}/delete`, {});
      dialog.close();
      pendingDelete = undefined;
      el("library-message").textContent =
        `Deleted ${job.name}. Source PBF files were kept.`;
      await refresh();
      update();
    } catch (error) {
      document.getElementById("dataset-delete-error")!.textContent =
        String(error);
    } finally {
      button.disabled = false;
    }
  };
}
export async function startBuilder() {
  document.addEventListener("atlas-jobs-changed", () => void refresh());
  updateComposition();
  el("storage-refresh").onclick = async () => {
    const button = el<HTMLButtonElement>("storage-refresh");
    button.disabled = true;
    try {
      await refresh();
      update();
    } finally {
      button.disabled = false;
    }
  };
  const data = await refresh();
  if (!data) return;
  source = data.source;
  installedScope = { ...source, available: data.available };
  globalScope = data.globalSource;
  // A fresh installation has an Atlas sample, but no cached planet source.
  if (!cachedSources.length)
    document.querySelector<HTMLInputElement>(
      'input[name="build-source-kind"][value="atlas"]',
    )!.checked = true;
  if (sourceKind() === "atlas")
    el<HTMLSelectElement>("provider").value = "local";
  populateSources();
  initialized = true;
  configureSource();
  setupDeletion();
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    'a[href="#sources"]',
  ))
    link.onclick = () => {
      (document.getElementById("sources") as HTMLDetailsElement).open = true;
    };
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="build-source-kind"]',
  ))
    radio.onchange = async () => {
      populateSources();
      configureSource();
      await switchPreview();
    };
  el("britain").onclick = () => {
    points = [
      [-8.5, 49.75],
      [2, 49.75],
      [2, 61],
      [-8.5, 61],
    ];
    closed = true;
    mode = null;
    el<HTMLInputElement>("name").value = "Britain area";
    preview?.fitArea([-8.5, 49.75, 2, 61]);
    el("message").textContent =
      "Britain starter rectangle: includes Ireland and nearby coasts. Refine the area or draw a polygon, choose capabilities, then start when ready.";
    update();
  };
  for (const k of ["rect", "polygon"] as const)
    el(k).onclick = () => {
      mode = k;
      points = [];
      closed = false;
      update();
      el("map").querySelector("canvas")?.focus();
    };
  el("finish").onclick = finish;
  el("clear").onclick = clear;
  el("undo").onclick = () => {
    points.pop();
    closed = false;
    mode = "polygon";
    update();
  };
  el("fit").onclick = () => preview?.fit();
  el("view").onclick = () => {
    if (!preview) return;
    const b = preview.view(),
      s = scope().bounds,
      w = Math.max(b[0], s[0]),
      south = Math.max(b[1], s[1]),
      e = Math.min(b[2], s[2]),
      n = Math.min(b[3], s[3]);
    if (w >= e || south >= n) {
      el("message").textContent = "This view is outside the installed source.";
      return;
    }
    points = [
      [w, south],
      [e, south],
      [e, n],
      [w, n],
    ];
    finish();
  };
  el("provider").onchange = () => void switchPreview();
  el("preset").onchange = () => {
    const preset = el<HTMLSelectElement>("preset").value;
    if (preset === "custom") return;
    for (const [k, input] of fields)
      input.checked =
        !input.disabled &&
        (preset === "all" ||
          (preset === "analysis" &&
            [
              "feature-objects",
              "feature-boundaries",
              "search",
              "reverse",
              "query-peaks",
            ].includes(k)) ||
          (preset === "geometry" &&
            (k.startsWith("layer-") || k === "ocean")) ||
          (preset === "view" &&
            (k.startsWith("layer-") ||
              ["places", "streets", "pois", "ocean"].includes(k))) ||
          (preset === "water-buildings" &&
            ["layer-water", "layer-buildings", "ocean"].includes(k)));
    update();
  };
  el<HTMLFormElement>("form").onsubmit = async (event) => {
    event.preventDefault();
    if (el<HTMLButtonElement>("submit").disabled) return;
    if (remotePbf() && (!sourcePlan || planKey !== sourceKey())) return;
    submitting = true;
    update();
    try {
      await request("/admin/preparations", {
        ...selection(),
        ...(atlasSource() ? { sourceAtlasId: atlasSource()!.id } : {}),
        ...(cached()
          ? {
              cachedSourceId:
                el<HTMLSelectElement>("data-source").value.slice(7),
            }
          : {}),
        ...(remotePbf()
          ? {
              sourcePlanId: sourcePlan!.id,
              maxSourceBytes: sourceArea().maxSourceBytes,
            }
          : {}),
      });
      el("message").textContent =
        "Preparation queued. Builds run one at a time and continue when you leave this page. Add another area now.";
      await refresh();
    } catch (e) {
      el("message").textContent = String(e);
    } finally {
      submitting = false;
      update();
    }
  };
  el("data-source").onchange = async () => {
    configureSource();
    await switchPreview();
  };
  document.addEventListener(
    "atlas-source-prepare",
    (event) =>
      void chooseSource("cached", `cached:${(event as CustomEvent).detail.id}`),
  );
  el("form").addEventListener("input", update);
  el("form").addEventListener("change", update);
  el("jump").onclick = () => {
    const parts = el<HTMLInputElement>("coordinates")
      .value.split(",")
      .map((v) => v.trim());
    const [lat, lon] = parts.map(Number);
    if (
      parts.length !== 2 ||
      parts.some((v) => !v) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat!) > 85 ||
      Math.abs(lon!) > 180
    ) {
      el("message").textContent =
        "Enter latitude, longitude; for example 43.735, 7.423.";
      return;
    }
    preview?.focus([lon!, lat!]);
  };
  el("check-source").onclick = async () => {
    checking = true;
    const key = sourceKey();
    update();
    el("source-plan").textContent =
      "Finding a covering region and checking download size…";
    try {
      const plan = (await request(
        "/admin/preparations/source-plan",
        sourceArea(),
      )) as PbfPlan;
      if (!remotePbf() || key !== sourceKey()) {
        el("source-plan").textContent =
          "Selection changed or source plan expired. Check the PBF source again.";
        return;
      }
      sourcePlan = plan;
      planKey = key;
      const card = el("source-plan"),
        link = document.createElement("a");
      link.href = plan.region.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Source PBF ↗";
      card.replaceChildren(
        text("h3", plan.region.name),
        text(
          "p",
          `${bytes(plan.bytes)} source download · published ${new Date(plan.lastModified).toLocaleDateString()}`,
        ),
        text(
          "p",
          "The entire regional PBF is needed before cropping. A verified copy already on this server will be reused. This plan is valid for 30 minutes.",
        ),
        link,
      );
    } catch (e) {
      sourcePlan = undefined;
      el("source-plan").textContent = String(e);
    } finally {
      checking = false;
      update();
    }
  };
  await switchPreview();
  if (
    new URL(location.href).searchParams.get("area") === "britain" &&
    cachedSource()?.kind === "planet"
  )
    el<HTMLButtonElement>("britain").click();
  const poll = async () => {
    if (!document.hidden) {
      await refresh();
      update();
    }
    setTimeout(() => void poll(), 1500);
  };
  void poll();
}
