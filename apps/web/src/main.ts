import {
  AtlasReader,
  HttpSource,
  FileSource,
  type ReadEvent,
  type ByteSource,
} from "../../../packages/format/src/reader";
import {
  AtlasMap,
  MAX_VIEW_ZOOM,
  type MapStats,
} from "../../../packages/renderer/src/map";
import { RouteControls } from "./routing";
import { SearchControls } from "./search";
import { OfflineControls } from "./offline";
import { project } from "../../../packages/format/src/index";
let world: OfflineControls | undefined;
let search: SearchControls | undefined;
let routing: RouteControls | undefined;
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
let reader: AtlasReader;
let map: AtlasMap | undefined;
let sourceLabel = "server";
let events: ReadEvent[] = [];
const formatBytes = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(2)} MB`
    : `${(bytes / 1_000).toFixed(1)} KB`;
const number = (value: number) => value.toLocaleString("en-US");
function error(message: string) {
  el("error").textContent = message;
  el("error").hidden = false;
}
function telemetry(event?: ReadEvent) {
  if (event && !event.cached) {
    events.unshift(event);
    events = events.slice(0, 6);
  }
  if (!reader) return;
  const bytes = formatBytes(reader.bytesRead).split(" ");
  el("bytes-read").replaceChildren(
    document.createTextNode(`${bytes[0]} `),
    Object.assign(document.createElement("span"), { textContent: bytes[1] }),
  );
  el("request-count").textContent = String(reader.requests);
  el("cached-count").textContent = String(reader.cache.size);
  for (const purpose of [
    "directory",
    "map",
    "streetNames",
    "pois",
    "routing",
    "search",
    "queries",
  ] as const) {
    el(`bytes-${purpose}`).textContent = formatBytes(
      reader.bytesByPurpose[purpose] +
        (purpose === "streetNames" ? reader.bytesByPurpose.labels : 0),
    );
  }
  if (reader.index) {
    const percent = (reader.bytesRead / reader.index.header.fileLength) * 100;
    el("transfer-meter").style.width = `${Math.min(percent, 100)}%`;
    el("transfer-percent").textContent =
      `${percent.toFixed(1)}% of the package read`;
  }
  if (!event || event.cached) return;
  const list = el("read-log");
  list.replaceChildren();
  for (const read of events) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.className = "read-name";
    title.append(document.createTextNode(read.key.replace("tile/", "")));
    const badge = document.createElement("span");
    badge.className = "read-badge";
    badge.textContent = sourceLabel === "server" ? "206" : "FILE";
    title.append(badge);
    const meta = document.createElement("div");
    meta.className = "read-meta";
    meta.textContent = `${number(read.start)} → ${formatBytes(read.bytes)}`;
    li.append(title, meta);
    list.append(li);
  }
}
function stats(s: MapStats) {
  el<HTMLButtonElement>("zoom-in").disabled = s.zoom >= MAX_VIEW_ZOOM;
  el<HTMLButtonElement>("zoom-out").disabled =
    s.zoom <= Math.max(0, reader.index.manifest.minZoom - 1);
  el("labels-stat").textContent =
    `${s.labels.roads} streets · ${s.labels.pois} POIs`;
  el("labels-stat").title = s.labels.missing
    ? `${s.labels.missing} nearby label blocks missing${s.labels.loading ? " (loading)" : ""}`
    : "Nearby labels ready";
  el("zoom-stat").textContent = s.zoom.toFixed(1);
  el("tiles-stat").textContent = `${s.tiles}/${s.wanted}`;
  el("triangles-stat").textContent = number(s.triangles);
  el("draw-stat").textContent =
    s.drawMs < 0.1 ? "<0.1 ms" : `${s.drawMs.toFixed(1)} ms`;
  el("render-status").textContent = s.loading
    ? "Loading map blocks"
    : s.missing
      ? "Some tiles are unavailable"
      : "WASM renderer active";
  el("ready-state").textContent = s.loading
    ? "READING"
    : s.missing
      ? "PARTIAL"
      : "READY";
  el("ready-state").dataset.state = s.loading
    ? "loading"
    : s.missing
      ? "partial"
      : "ready";
  el("transport-detail").textContent = reader.offline
    ? `${s.missing} missing visible tiles · network reads disabled.`
    : `${s.tiles} visible tiles · ${formatBytes(reader.bytesRead)} this session.`;
  telemetry();
}
async function open(source: ByteSource) {
  world?.destroy();
  world = undefined;
  search?.destroy();
  search = undefined;
  routing?.destroy();
  routing = undefined;
  map?.destroy();
  map = undefined;
  events = [];
  el("error").hidden = true;
  el("query-result").hidden = true;
  el<HTMLButtonElement>("highest-peak").disabled = true;
  el<HTMLButtonElement>("open-file").disabled = true;
  el<HTMLInputElement>("offline").checked = false;
  el("connection-label").textContent =
    sourceLabel === "server" ? "Reading from server" : "Reading a local file";
  const nextReader = new AtlasReader(source, (event) => {
    if (reader === nextReader) telemetry(event);
  });
  reader = nextReader;
  try {
    await reader.open();
    const m = reader.index.manifest;
    el("dataset-name").textContent = m.name;
    el("dataset-subtitle").textContent =
      `OSM EXTRACT · Z${m.minZoom}–${m.maxZoom}`;
    el("feature-label").textContent =
      m.featureCountKind === "tile-records" ? "Tile records" : "Features";
    el<HTMLAnchorElement>("download").download =
      `${m.name.toLowerCase().replaceAll(" ", "-")}.atlas`;
    el("feature-count").textContent = number(m.features);
    el("tile-count").textContent = number(reader.index.tileCount);
    el("package-size").textContent = formatBytes(
      reader.index.header.fileLength,
    );
    el("snapshot-id").textContent = `${m.snapshot.slice(0, 24)}…`;
    const heading = document.querySelector(".map-heading>span:last-child")!;
    heading.textContent = m.name;
    document.querySelector(".map-heading .eyebrow")!.textContent =
      `${((m.bounds[1] + m.bounds[3]) / 2).toFixed(1)}° N / ${((m.bounds[0] + m.bounds[2]) / 2).toFixed(1)}° E`;
    map = await AtlasMap.create(
      el<HTMLCanvasElement>("map"),
      reader,
      stats,
      error,
    );
    map.onPickModeChange = (hint) => {
      el("pick-banner").hidden = hint === null;
      el("pick-banner").textContent = hint ?? "";
    };
    routing = new RouteControls(reader, map);
    search = new SearchControls(reader, map, routing);
    map.onPoiSelect = (poi) => search?.select(poi);
    for (const id of ["street-labels", "poi-labels"])
      el<HTMLInputElement>(id).disabled =
        !m.capabilities.includes("map-labels");
    setLabels();
    world = new OfflineControls(reader, map, async (file) => {
      sourceLabel = "file";
      el("download").hidden = true;
      await open(new FileSource(file));
    });
    if (m.selection) map.setSelection(m.selection.polygon);
    if (m.name === "Vienna Plus") {
      map.center = project(16.373, 48.208);
      map.zoom = 11;
      map.invalidate();
    }
    map.setGrid(el<HTMLInputElement>("tile-grid").checked);
    setLayers();
    el<HTMLButtonElement>("highest-peak").disabled =
      !m.capabilities.includes("peak-query");
    telemetry();
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    el("render-status").textContent = "Could not open package";
  } finally {
    el<HTMLButtonElement>("open-file").disabled = false;
  }
}
function setLabels() {
  map?.setLabels(
    el<HTMLInputElement>("street-labels").checked,
    el<HTMLInputElement>("poi-labels").checked,
  );
}
for (const id of ["street-labels", "poi-labels"])
  el<HTMLInputElement>(id).onchange = setLabels;
function setLayers() {
  let mask = 0;
  document
    .querySelectorAll<HTMLInputElement>("[data-mask]")
    .forEach((input) => {
      if (input.checked) mask |= Number(input.dataset.mask);
    });
  map?.setLayers(mask);
}
el("zoom-in").onclick = () => map?.zoomBy(1);
el("zoom-out").onclick = () => map?.zoomBy(-1);
el("fit").onclick = () => map?.fit();
el<HTMLInputElement>("tile-grid").onchange = (event) =>
  map?.setGrid((event.target as HTMLInputElement).checked);
el<HTMLInputElement>("offline").onchange = (event) => {
  const offline = (event.target as HTMLInputElement).checked;
  map?.setOffline(offline);
  el("connection-label").textContent = offline
    ? "Using cached blocks"
    : sourceLabel === "server"
      ? "Reading from server"
      : "Reading a local file";
  el("connection-dot").style.background = offline ? "#c88a41" : "#688668";
  el("error").hidden = true;
};
document
  .querySelectorAll<HTMLInputElement>("[data-mask]")
  .forEach((input) => (input.onchange = setLayers));
el("highest-peak").onclick = async () => {
  const button = el<HTMLButtonElement>("highest-peak");
  button.disabled = true;
  el("error").hidden = true;
  try {
    const result = await reader.highestPeak();
    const box = el("query-result");
    box.replaceChildren();
    box.hidden = false;
    if (result.peak) {
      const name = document.createElement("strong");
      name.textContent = result.peak.name;
      const elevation = document.createElement("span");
      elevation.className = "elevation";
      elevation.textContent = `${number(result.peak.elevation!)} m above sea level`;
      const note = document.createElement("p");
      note.textContent = `Highest recorded peak in this extract. ${result.known} known elevations; ${result.unknown} unknown. Computed here from a verified data block.`;
      box.append(name, elevation, note);
      map?.focus(result.peak);
      box.scrollIntoView({ block: "nearest" });
    } else {
      box.textContent =
        "No peaks with known numeric elevations in this package.";
    }
    telemetry();
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
  } finally {
    button.disabled = false;
  }
};
el("open-file").onclick = () => el<HTMLInputElement>("file-input").click();
el<HTMLInputElement>("file-input").onchange = async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) {
    sourceLabel = "file";
    el("download").hidden = true;
    await open(new FileSource(file));
  }
};
void open(new HttpSource("/maps/demo.atlas"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      el("shell-status").textContent =
        "App saved for offline use. Save a .atlas file to bring your map along.";
    })
    .catch(() => {
      el("shell-status").textContent =
        "Offline app storage unavailable. Local map files still work while this tab stays open.";
    });
}
