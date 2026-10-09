import { budgetControl, storageSize } from "./host-budget";
import {
  preparationSpace,
  capacityBudget,
  validBudget,
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
let outputBudget: ReturnType<typeof budgetControl> | undefined,
  sourceBudget: ReturnType<typeof budgetControl> | undefined;
const outputBytes = () =>
  el<HTMLInputElement>("budget").valueAsNumber * 1048576;
const sourceBytes = () =>
  el<HTMLInputElement>("source-budget").valueAsNumber * 1048576;
function spaceNeeded() {
  return preparationSpace(
    outputBytes(),
    global() ? (sourcePlan?.bytes ?? sourceBytes()) : undefined,
  );
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
    outputBudget?.setCapacity(capacityBudget(available, "output", global()));
    sourceBudget?.setCapacity(capacityBudget(available, "source", global()));
  }
  const estimate = el("storage-estimate");
  if (
    !validBudget(outputBytes()) ||
    (global() && !validBudget(sourceBytes()))
  ) {
    estimate.textContent = "Enter valid budgets to estimate preparation space.";
    estimate.dataset.insufficient = "false";
    return;
  }
  const needed = spaceNeeded();
  estimate.dataset.insufficient = String(
    available !== undefined && needed > available,
  );
  estimate.textContent = `${storageSize(needed)} estimated workspace${global() && !sourcePlan ? " using the source download cap; check the source for a tighter estimate" : ""}.${available !== undefined ? (needed > available ? ` Exceeds available space by ${storageSize(needed - available)}.` : ` About ${storageSize(available - needed)} would remain.`) : ""}`;
}
let checking = false,
  submitting = false,
  planKey = "";
const global = () => el<HTMLSelectElement>("data-source").value === "global";
const scope = () => (global() ? globalScope : installedScope);
const sourceArea = () => ({
  polygon: points,
  paddingCells: Number(el<HTMLSelectElement>("padding").value),
  profiles: selection().profiles,
  maxSourceBytes: Number(el<HTMLInputElement>("source-budget").value) * 1048576,
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
  const valid =
    validBudget(outputBytes()) && (!global() || validBudget(sourceBytes()));
  el<HTMLButtonElement>("check-source").disabled =
    !closed || checking || !validBudget(sourceBytes());
  el<HTMLButtonElement>("submit").disabled =
    !closed ||
    submitting ||
    !valid ||
    (global() && !sourcePlan) ||
    (storage !== undefined && spaceNeeded() > storage.availableBytes);
  el("submit").textContent = global()
    ? "Download, prepare & host ↗"
    : "Prepare & host map ↗";
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
    el("message").textContent = global()
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
    );
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
    featureKinds: ["water", "buildings", "railways", "roads", "land"].filter(
      (k) => checked(`feature-${k}`),
    ) as FeatureKind[],
    paddingCells: Number(el<HTMLSelectElement>("padding").value),
    maxBytes: Number(el<HTMLInputElement>("budget").value) * 1024 * 1024,
  };
}
async function request(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
const composition = new Set<string>();
function updateComposition() {
  el<HTMLAnchorElement>("compose").href = composition.size
    ? `/compose?maps=${[...composition].join(",")}`
    : "/compose";
  el("compose").textContent = composition.size
    ? `Compose ${composition.size} selected maps ↗`
    : "Compose hosted maps ↗";
  el("compose-count").textContent = composition.size
    ? "These sources will share one map view."
    : "Choose maps below, or open the full library.";
}
let lastJobs = "";
function jobs(values: PreparationJob[]) {
  const identity = JSON.stringify(values);
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
      text("span", job.state, "state-badge"),
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
          `${bytes(job.size!)} · z${m.minZoom}–${m.maxZoom} · ${m.tileLayers?.join(", ") || "no display geometry"}`,
        ),
        text("p", m.capabilities.join(" · "), "quiet"),
      );
      const links = document.createElement("div");
      links.className = "host-actions";
      for (const [label, url] of [
        ["Open map ↗", `/?map=${job.id}`],
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
      card.append(links, details, select);
      library.append(card);
    } else {
      card.append(text("p", job.error ?? job.progress.message));
      if (job.state === "running" || job.state === "cancelling") {
        const progress = document.createElement("progress");
        progress.max = job.progress.total || 1;
        if (job.progress.total) progress.value = job.progress.completed;
        progress.setAttribute("aria-label", `Preparing ${job.name}`);
        card.append(
          progress,
          text(
            "p",
            `${job.progress.phase}${job.progress.total ? " · " + (job.progress.unit === "bytes" ? `${bytes(job.progress.completed)} / ${bytes(job.progress.total)}` : `${job.progress.completed.toLocaleString()} / ${job.progress.total.toLocaleString()} blocks`) : ""} · ${bytes(job.progress.writtenBytes)} Atlas written`,
            "quiet",
          ),
        );
        const cancel = text(
          "button",
          job.state === "cancelling" ? "Cancelling…" : "Cancel preparation",
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
      list.append(card);
    }
  }
  if (!list.children.length)
    list.append(
      text(
        "p",
        "No preparations running. Jobs continue when you leave this page.",
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
    jobs(data.jobs);
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
  el("source").textContent = global()
    ? "Worldwide OSM · Geofabrik extracts"
    : source.name;
  el("source-note").textContent = global()
    ? "Choose an area anywhere in the supported coverage. The source check finds one covering Geofabrik region, including routing padding. OpenFreeMap supplies only the preview."
    : `Source coverage: ${source.bounds.map((n: number) => n.toFixed(3)).join(", ")}. Prepare from this installed snapshot; OpenFreeMap is a preview only.`;
  el<HTMLInputElement>("name").value = global()
    ? "My OSM excerpt"
    : `${source.name} excerpt`;
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
  ])
    checkbox(
      "features",
      `feature-${k}`,
      label!,
      a.featureKinds.includes(k as FeatureKind),
      false,
    );
  el("global-controls").hidden = !global();
  el<HTMLInputElement>("source-budget").disabled = !global();
  el<HTMLInputElement>("source-budget").required = global();
  el("jump-controls").hidden = !global();
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
export async function startBuilder() {
  outputBudget = budgetControl("prepare-budget");
  sourceBudget = budgetControl("prepare-source-budget");
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
  const worldOption = el<HTMLSelectElement>(
    "data-source",
  ).querySelector<HTMLOptionElement>('option[value="global"]')!;
  worldOption.disabled = !data.globalSource.ready;
  if (!data.globalSource.ready)
    worldOption.textContent += " · requires Osmium & Cargo";
  configureSource();
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
    if (!preset) return;
    for (const [k, input] of fields)
      input.checked =
        !input.disabled &&
        (preset === "all" ||
          (preset === "view" &&
            (k.startsWith("layer-") ||
              ["places", "streets", "pois"].includes(k))) ||
          (preset === "water-buildings" &&
            ["layer-water", "layer-buildings"].includes(k)));
    update();
  };
  el<HTMLFormElement>("form").onsubmit = async (event) => {
    event.preventDefault();
    if (global() && (!sourcePlan || planKey !== sourceKey())) return;
    submitting = true;
    update();
    try {
      await request("/admin/preparations", {
        ...selection(),
        ...(global()
          ? {
              sourcePlanId: sourcePlan!.id,
              maxSourceBytes: sourceArea().maxSourceBytes,
            }
          : {}),
      });
      el("message").textContent =
        "Preparation started. You can leave this page and return to follow progress.";
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
      if (!global() || key !== sourceKey()) {
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
  const poll = async () => {
    if (!document.hidden) {
      await refresh();
      if (sourcePlan && sourcePlan.expiresAt <= Date.now()) update();
      else
        el<HTMLButtonElement>("submit").disabled =
          !closed ||
          submitting ||
          !validBudget(outputBytes()) ||
          (global() && (!sourcePlan || !validBudget(sourceBytes()))) ||
          (storage !== undefined && spaceNeeded() > storage.availableBytes);
    }
    setTimeout(() => void poll(), 1500);
  };
  void poll();
}
