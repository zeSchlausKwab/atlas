import { ToolControls } from "./tools";
let tools: ToolControls | undefined;
import { ReachabilityControls } from "./reachability";
import { BrowserBlockStore } from "../../../packages/format/src/store";
const blockStore =
  typeof indexedDB !== "undefined" ? new BrowserBlockStore() : undefined;
import { StyleControls } from "./style";
import { setupTabs } from "./tabs";
import { OperationSession, executionText, type Capability } from "./operations";
import { ExtractControls } from "./extract";
setupTabs();
let operations: OperationSession | undefined;
let extractor: ExtractControls | undefined;
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
import {
  project,
  MAP_LAYERS,
  LAYER_MASKS,
  type MapLayer,
} from "../../../packages/format/src/index";
let world: OfflineControls | undefined;
let search: SearchControls | undefined;
let routing: RouteControls | undefined;
let reachability: ReachabilityControls | undefined;
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const LAYER_SETTINGS = "atlas-map-layers-v1";
function selectedLayers(): MapLayer[] {
  const mask = [...document.querySelectorAll<HTMLInputElement>("[data-mask]")]
    .filter((e) => e.checked)
    .reduce((mask, e) => mask | Number(e.dataset.mask), 0);
  return MAP_LAYERS.filter((l) => (mask & LAYER_MASKS[l]) !== 0);
}
function saveLayers() {
  try {
    localStorage.setItem(
      LAYER_SETTINGS,
      JSON.stringify({
        layers: selectedLayers(),
        placeNames: el<HTMLInputElement>("place-labels").checked,
        streetNames: el<HTMLInputElement>("street-labels").checked,
        pois: el<HTMLInputElement>("poi-labels").checked,
      }),
    );
  } catch {}
}
try {
  const saved = JSON.parse(localStorage.getItem(LAYER_SETTINGS) ?? "null");
  if (
    saved &&
    Array.isArray(saved.layers) &&
    saved.layers.every((l: string) => MAP_LAYERS.includes(l as MapLayer)) &&
    typeof saved.streetNames === "boolean" &&
    typeof saved.pois === "boolean"
  ) {
    const mask = saved.layers.reduce(
      (m: number, l: MapLayer) => m | LAYER_MASKS[l],
      0,
    );
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "[data-mask]",
    ))
      input.checked = (mask & Number(input.dataset.mask)) !== 0;
    el<HTMLInputElement>("place-labels").checked = saved.placeNames !== false;
    el<HTMLInputElement>("street-labels").checked = saved.streetNames;
    el<HTMLInputElement>("poi-labels").checked = saved.pois;
  }
} catch {}
let reader: AtlasReader;
let map: AtlasMap | undefined;
const appearance = new StyleControls(() => map);
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
    "placeNames",
    "streetNames",
    "pois",
    "routing",
    "search",
    "queries",
    "features",
  ] as const) {
    el(`bytes-${purpose}`).textContent = formatBytes(
      reader.bytesByPurpose[purpose] +
        (purpose === "streetNames" ? reader.bytesByPurpose.labels : 0),
    );
  }
  for (const layer of [...MAP_LAYERS, "combined"] as const)
    el(`bytes-layer-${layer}`).textContent = formatBytes(
      reader.bytesByLayer[layer],
    );
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
let memoryUpdated = 0;
function stats(s: MapStats) {
  if (map && performance.now() - memoryUpdated > 250) {
    memoryUpdated = performance.now();
    const m = map.memory;
    const entries = [
      ...Object.entries(m.reader.decoded).map(
        ([k, v]) => [`${k} bytes`, v] as const,
      ),
      ["Directory descriptors", m.reader.directory] as const,
      ["Parsed labels", m.labels] as const,
      ["GPU meshes", m.meshes] as const,
    ];
    const list = el("cache-memory");
    list.replaceChildren();
    for (const [name, v] of entries) {
      const row = document.createElement("div"),
        term = document.createElement("dt"),
        value = document.createElement("dd");
      term.textContent = name;
      value.textContent = `${formatBytes(v.bytes)} / ${formatBytes(v.budget)}`;
      value.title = `${v.entries} entries · ${v.evictions} evictions${v.overage ? ` · ${formatBytes(v.overage)} active overage` : ""}`;
      row.append(term, value);
      list.append(row);
    }
    list.dataset.memory = JSON.stringify(m);
  }
  el<HTMLButtonElement>("zoom-in").disabled = s.zoom >= MAX_VIEW_ZOOM;
  el<HTMLButtonElement>("zoom-out").disabled =
    s.zoom <= Math.max(0, reader.index.manifest.minZoom - 1);
  el("labels-stat").textContent =
    `${s.labels.places ?? 0} places · ${s.labels.roads} streets · ${s.labels.pois} POIs`;
  el("labels-stat").title = s.labels.missing
    ? `${s.labels.missing} nearby label blocks missing${s.labels.loading ? " (loading)" : ""}`
    : "Nearby labels ready";
  el("zoom-stat").textContent = s.zoom.toFixed(1);
  el("tiles-stat").textContent = `${s.tiles}/${s.wanted}`;
  el("triangles-stat").textContent = number(s.triangles);
  el("draw-stat").textContent =
    s.drawMs < 0.1 ? "<0.1 ms" : `${s.drawMs.toFixed(1)} ms`;
  el("render-status").textContent = s.loading
    ? s.fallbackTiles
      ? "Updating detail · previous tiles visible"
      : "Loading map blocks"
    : s.missing
      ? s.fallbackTiles
        ? "Using cached detail · some tiles unavailable"
        : "Some tiles are unavailable"
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
let session = 0;
let reopening:
  | { source: ByteSource; center?: [number, number]; zoom?: number }
  | undefined;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
function closeSession() {
  session++;
  clearTimeout(cacheTimer);
  cacheTimer = undefined;
  reader?.dispose();
  tools?.destroy();
  tools = undefined;
  extractor?.destroy();
  extractor = undefined;
  world?.destroy();
  world = undefined;
  search?.destroy();
  search = undefined;
  reachability?.destroy();
  reachability = undefined;
  routing?.destroy();
  routing = undefined;
  operations?.destroy();
  operations = undefined;
  map?.destroy();
  map = undefined;
}
async function open(source: ByteSource) {
  closeSession();
  const opening = session;
  el("cache-paused").hidden = true;
  el("map").style.visibility = "";
  document
    .querySelectorAll<HTMLElement>(".sidebar, .inspector")
    .forEach((e) => (e.inert = false));
  el("render-status").textContent = "Opening map package…";
  events = [];
  el("error").hidden = true;
  el("query-result").hidden = true;
  el<HTMLButtonElement>("highest-peak").disabled = true;
  el<HTMLButtonElement>("open-file").disabled = true;
  el<HTMLInputElement>("offline").checked = false;
  el("connection-label").textContent =
    sourceLabel === "server" ? "Reading from server" : "Reading a local file";
  const nextReader = new AtlasReader(
    source,
    (event) => {
      if (reader === nextReader) telemetry(event);
    },
    {
      store: blockStore,
      sourceId:
        source instanceof HttpSource
          ? new URL(source.url, location.href).href
          : undefined,
    },
  );
  reader = nextReader;
  try {
    await nextReader.open();
    if (session !== opening) return;
    el<HTMLInputElement>("offline").checked = reader.offline;
    if (reader.offline)
      el("connection-label").textContent = "Using cached blocks";
    const m = reader.index.manifest;
    el("layer-transport").textContent = m.tileLayers
      ? "Choose any combination. Only selected layers are requested."
      : "This older package has combined geometry tiles. Switches hide geometry; convert the package with split-layers for selective downloads.";
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
    const nextMap = await AtlasMap.create(
      el<HTMLCanvasElement>("map"),
      reader,
      stats,
      (message) => {
        // Cache misses already appear as partial map coverage in the status bar.
        if (reader.offline && message.startsWith("Error: Not cached:")) return;
        error(message);
      },
      {
        style: appearance.style,
        scene: appearance.scene,
        layers: selectedLayers(),
        placeNames: el<HTMLInputElement>("place-labels").checked,
        streetNames: el<HTMLInputElement>("street-labels").checked,
        pois: el<HTMLInputElement>("poi-labels").checked,
      },
    );
    if (session !== opening) {
      nextMap.destroy();
      return;
    }
    map = nextMap;
    map.onSceneChange = (scene) => appearance.receiveScene(scene);
    const heights = m.buildingHeights;
    el("height-coverage").textContent = heights
      ? `${number(heights.tagged)} tagged heights · ${number(heights.estimated)} estimated from floors · ${number(heights.missing)} use fallback.${m.featureCountKind === "tile-records" ? " Counts are tile records." : ""}`
      : "This package has no height attributes. Buildings use the fallback height.";
    el("scene-badge").textContent = heights
      ? "3D · OSM heights + estimates"
      : "3D · fallback heights";
    el<HTMLInputElement>("place-labels").disabled =
      !m.places.length &&
      !reader.index.blocks.some((b) => b.key === "labels/places");
    map.onPickModeChange = (hint) => {
      el("pick-banner").hidden = hint === null;
      el("pick-banner").textContent = hint ?? "";
    };
    operations = new OperationSession(reader, (e) => {
      el("execution-status").textContent =
        `${e.operation} · ${executionText(e)}`;
      el("api-transfer").textContent =
        `${operations?.apiRequests ?? 0} API responses · ${formatBytes(operations?.apiBytes ?? 0)}`;
      telemetry();
    });
    el("execution-status").textContent = "No computation requested.";
    el("api-transfer").textContent = "0 API responses · 0 KB";
    el<HTMLSelectElement>("execution-mode").querySelector<HTMLOptionElement>(
      'option[value="server"]',
    )!.disabled = !operations.remote;
    if (!operations.remote)
      el<HTMLSelectElement>("execution-mode").value = "device";
    routing = new RouteControls(reader, map, operations);
    reachability = new ReachabilityControls(map, operations, () =>
      routing?.profileChanged(),
    );
    search = new SearchControls(reader, map, routing, operations);
    extractor = new ExtractControls(map, operations);
    tools = new ToolControls(map, operations, extractor);
    map.onPoiSelect = (poi) => search?.select(poi);
    for (const id of ["street-labels", "poi-labels"])
      el<HTMLInputElement>(id).disabled =
        !m.capabilities.includes("map-labels");
    setLabels();
    world = new OfflineControls(
      reader,
      map,
      async (file) => {
        sourceLabel = "file";
        el("download").hidden = true;
        await open(new FileSource(file));
      },
      operations,
      () => ({
        layers: selectedLayers(),
        placeNames: el<HTMLInputElement>("place-labels").checked,
        streetNames: el<HTMLInputElement>("street-labels").checked,
        pois: el<HTMLInputElement>("poi-labels").checked,
      }),
    );
    configureOperations();
    if (m.selection) map.setSelection(m.selection.polygon);
    if (m.name === "Vienna Plus") {
      map.center = project(16.373, 48.208);
      map.zoom = 11;
      map.invalidate();
    }
    map.setGrid(el<HTMLInputElement>("tile-grid").checked);
    refreshCacheView();
    setLayers();
    el<HTMLButtonElement>("highest-peak").disabled =
      !operations.enabled.has("queries") ||
      !m.capabilities.includes("peak-query");
    telemetry();
  } catch (e) {
    if (session !== opening) return;
    error(e instanceof Error ? e.message : String(e));
    el("render-status").textContent = "Could not open package";
  } finally {
    if (session === opening)
      el<HTMLButtonElement>("open-file").disabled = false;
  }
}
async function refreshCacheView() {
  clearTimeout(cacheTimer);
  cacheTimer = undefined;
  const enabled = el<HTMLInputElement>("cache-view").checked;
  el("cache-legend").hidden = !enabled;
  map?.setCacheView(enabled);
  if (!enabled || !map) return;
  const active = map;
  const keys =
    (await blockStore?.keys(active.reader.index.manifest.snapshot)) ?? [];
  if (map === active)
    active.setCacheView(
      el<HTMLInputElement>("cache-view").checked,
      new Set(keys),
    );
}
blockStore?.subscribe(() => {
  if (!el<HTMLInputElement>("cache-view").checked || cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = undefined;
    void refreshCacheView();
  }, 200);
});
el<HTMLInputElement>("cache-view").onchange = () => {
  void refreshCacheView();
};
el("purge-caches").onclick = async () => {
  const button = el<HTMLButtonElement>("purge-caches");
  button.disabled = true;
  button.textContent = "Purging…";
  if (reader && !reopening)
    reopening = { source: reader.source, center: map?.center, zoom: map?.zoom };
  closeSession();
  // Other tabs must also release readers before the shared persistent cache clears.
  cacheChannel?.postMessage("close");
  showCachePause("Clearing Atlas caches…");
  try {
    await blockStore?.clear();
    await shellRegistration;
    const registration =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
    if (registration?.active)
      await shellCommand(registration.active, "purge-atlas-caches");
    if ("caches" in globalThis)
      await Promise.all(
        (await caches.keys())
          .filter((k) => k.startsWith("atlas-shell-"))
          .map((k) => caches.delete(k)),
      );
    el("cache-purge-status").textContent =
      "Atlas caches cleared. Reopen to load this view afresh. Saved files and preferences are kept.";
    el("shell-status").textContent =
      "Offline app shell cleared. Reload online to cache the app again.";
  } catch (e) {
    el("cache-purge-status").textContent =
      `Some caches could not be cleared: ${String(e)}. You can retry.`;
  } finally {
    button.disabled = false;
    button.textContent = "Purge caches";
    el<HTMLButtonElement>("reopen-map").disabled = false;
  }
};
function showCachePause(message: string) {
  el("map").style.visibility = "hidden";
  document
    .querySelectorAll<HTMLElement>(".sidebar, .inspector")
    .forEach((e) => (e.inert = true));
  el("cache-paused").hidden = false;
  el("cache-purge-status").textContent = message;
  el("error").hidden = true;
  el("query-result").hidden = true;
  el("render-status").textContent = "Map paused · caches released";
  el("ready-state").textContent = "PAUSED";
  el("ready-state").dataset.state = "paused";
  el("tiles-stat").textContent = "0/0";
  el("triangles-stat").textContent = "0";
  el("draw-stat").textContent = "—";
  el("transport-detail").textContent = "No map requests until you reopen.";
  el("cached-count").textContent = "0";
  el("cache-memory").replaceChildren();
  delete el("cache-memory").dataset.memory;
  el<HTMLButtonElement>("reopen-map").disabled = true;
}
el("reopen-map").onclick = async () => {
  const saved = reopening;
  if (!saved) return;
  reopening = undefined;
  await open(
    saved.source instanceof HttpSource
      ? new HttpSource(saved.source.url)
      : saved.source,
  );
  if (map && saved.center && saved.zoom !== undefined) {
    map.center = saved.center;
    map.zoom = saved.zoom;
    map.invalidate();
  }
};
const cacheChannel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("atlas-cache-control")
    : undefined;
if (cacheChannel)
  cacheChannel.onmessage = async ({ data }) => {
    if (data !== "close") return;
    if (reader && !reopening)
      reopening = {
        source: reader.source,
        center: map?.center,
        zoom: map?.zoom,
      };
    closeSession();
    showCachePause("Cache purge requested in another Atlas tab.");
    // Drain this tab's queued writes too, even if the other tab cleared first.
    try {
      await blockStore?.clear();
    } catch {
      el("cache-purge-status").textContent =
        "Could not clear shared storage. Retry Purge caches.";
    }
    el<HTMLButtonElement>("reopen-map").disabled = false;
  };
function configureOperations() {
  if (!operations) return;
  const enabled = [
    ...document.querySelectorAll<HTMLInputElement>("[data-purpose]"),
  ]
    .filter((e) => e.checked)
    .map((e) => e.dataset.purpose as Capability);
  const mode = el<HTMLSelectElement>("execution-mode").value as
    | "device"
    | "server";
  operations.configure(mode, enabled);
  el("execution-hint").textContent =
    operations.mode === "server"
      ? "Receive results; the source data stays on the server."
      : "Compute here; keep the downloaded data for offline use.";
  routing?.refresh();
  reachability?.refresh();
  search?.refresh();
  extractor?.refresh();
  void tools?.refresh();
  world?.refresh();
  el<HTMLButtonElement>("highest-peak").disabled =
    !enabled.includes("queries") ||
    !reader.index.manifest.capabilities.includes("peak-query");
}
el("execution-mode").addEventListener("change", configureOperations);
for (const input of document.querySelectorAll<HTMLInputElement>(
  "[data-purpose]",
))
  input.addEventListener("change", configureOperations);
function setLabels() {
  saveLayers();
  world?.refresh();
  map?.setLabels(
    el<HTMLInputElement>("street-labels").checked,
    el<HTMLInputElement>("poi-labels").checked,
    el<HTMLInputElement>("place-labels").checked,
  );
}
for (const id of ["place-labels", "street-labels", "poi-labels"])
  el<HTMLInputElement>(id).onchange = setLabels;
function setLayers() {
  map?.setLayers(selectedLayers());
  saveLayers();
  world?.refresh();
}
el("zoom-in").onclick = () => map?.zoomBy(1);
el("zoom-out").onclick = () => map?.zoomBy(-1);
el("fit").onclick = () => map?.fit();
el<HTMLInputElement>("tile-grid").onchange = (event) =>
  map?.setGrid((event.target as HTMLInputElement).checked);
el<HTMLInputElement>("offline").onchange = (event) => {
  const offline = (event.target as HTMLInputElement).checked;
  map?.setOffline(offline);
  routing?.refresh();
  reachability?.refresh();
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
    const active = operations!;
    const result = await active.peak();
    if (active !== operations) return;
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
      note.textContent = `Highest recorded peak in this extract. ${result.known} known elevations; ${result.unknown} unknown. ${executionText(result.execution)}.`;
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
    button.disabled =
      !operations?.enabled.has("queries") ||
      !reader.index.manifest.capabilities.includes("peak-query");
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

function shellCommand(worker: ServiceWorker, command: string) {
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Offline app cache operation timed out"));
    }, 10000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (data.ok) resolve();
      else reject(new Error(data.error));
    };
    worker.postMessage(command, [channel.port2]);
  });
}
const shellRegistration =
  "serviceWorker" in navigator
    ? navigator.serviceWorker
        .register("/sw.js")
        .then(async (registration) => {
          const worker = registration.installing;
          if (worker)
            await new Promise<void>((resolve) => {
              const check = () => {
                if (
                  worker.state === "activated" ||
                  worker.state === "redundant"
                )
                  resolve();
              };
              worker.addEventListener("statechange", check);
              check();
            });
          if (registration.active)
            await shellCommand(registration.active, "restore-atlas-shell");
        })
        .then(() => {
          el("shell-status").textContent =
            "App ready offline. Viewed tiles and routing cells are cached up to 128 MiB; browser storage may be evicted. Save a .atlas file for a portable copy.";
        })
        .catch(() => {
          el("shell-status").textContent =
            "Offline app storage unavailable. Local map files still work while this tab stays open.";
        })
    : Promise.resolve();
