import { HashtreeSource } from "../../../packages/hashtree/src/source";
import { setupMapWorkbench } from "./map-workbench";
import {
  parsePresentation,
  type Presentation,
} from "../../../packages/views/src/index";
import { BrowserAcquisition } from "./acquisition-client";
import { AcquisitionControls } from "./acquisition-controls";
let acquisition: BrowserAcquisition | undefined;
let savedAreas: AcquisitionControls | undefined;
import { TransferLedger } from "../../../packages/format/src/transfer-ledger";
import { ChatLauncher } from "./chat-launcher";
let chat: ChatLauncher | undefined;
import { clientConnection } from "./connection";
import { createComposer, type ClientComposer } from "./client-composer";
import {
  CompositionMap,
  type CompositionMapSource,
} from "../../../packages/renderer/src/composition";
import type { WorkspaceMap } from "../../../packages/renderer/src/workspace-map";
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
setupMapWorkbench();
setupTabs();
const connection = await clientConnection().catch((error) => {
  const element = document.getElementById("error")!;
  element.textContent = String(error);
  element.hidden = false;
  throw error;
});
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
let map: WorkspaceMap | undefined;
let composer: ClientComposer | undefined;
let composerAbort: AbortController | undefined;
let compositionSources: CompositionMapSource[] | undefined;
let compositionInput: ByteSource | undefined;
let toolSignature = "";
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
const aiTransfers = new TransferLedger();
function aiTransfer(event: ReadEvent) {
  aiTransfers.record(event);
  telemetry({ ...event, key: `AI · ${event.key}` });
}
function telemetry(event?: ReadEvent) {
  if (event && !event.cached) {
    events.unshift(event);
    events = events.slice(0, 6);
  }
  if (!reader) return;
  const readers = compositionSources?.map((s) => s.reader) ?? [reader];
  const sum = (f: (r: AtlasReader) => number) =>
    readers.reduce((n, r) => n + f(r), 0);
  const bytes = formatBytes(sum((r) => r.bytesRead) + aiTransfers.bytes).split(
    " ",
  );
  el("bytes-read").replaceChildren(
    document.createTextNode(`${bytes[0]} `),
    Object.assign(document.createElement("span"), { textContent: bytes[1] }),
  );
  el("request-count").textContent = String(
    sum((r) => r.requests) + aiTransfers.requests,
  );
  el("cached-count").textContent = String(sum((r) => r.cache.size));
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
      sum(
        (r) =>
          r.bytesByPurpose[purpose] +
          (purpose === "streetNames" ? r.bytesByPurpose.labels : 0),
      ) +
        aiTransfers.forPurpose(purpose) +
        (purpose === "streetNames" ? aiTransfers.forPurpose("labels") : 0) +
        (purpose === "features" ? aiTransfers.forPurpose("source") : 0),
    );
  }
  for (const layer of [...MAP_LAYERS, "combined"] as const)
    el(`bytes-layer-${layer}`).textContent = formatBytes(
      sum((r) => r.bytesByLayer[layer]) + (aiTransfers.layers.get(layer) ?? 0),
    );
  if (reader.index) {
    const percent = sum((r) => r.index.header.fileLength)
      ? ((sum((r) => r.bytesRead) + aiTransfers.bytes) /
          sum((r) => r.index.header.fileLength)) *
        100
      : 0;
    el("transfer-meter").style.width = `${Math.min(percent, 100)}%`;
    el("transfer-percent").textContent =
      `${percent.toFixed(1)}% of ${compositionSources ? "selected packages" : "the package"} read`;
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
  if (!reader?.index) return;
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
  if (compositionSources)
    el("transport-detail").textContent =
      `${compositionSources.length} selected maps · ${s.tiles} visible tiles · ${formatBytes(compositionSources.reduce((n, s) => n + s.reader.bytesRead, 0))} read${reader.offline ? " · cache only" : ""}.`;
  composer?.updateStatus();
  telemetry();
}
let session = 0;
let reopening:
  | {
      source: ByteSource;
      composition?: boolean;
      compositionInput?: ByteSource;
      center?: [number, number];
      zoom?: number;
    }
  | undefined;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
function closeSession() {
  session++;
  clearTimeout(cacheTimer);
  cacheTimer = undefined;
  reader?.dispose();
  closeTools();
  composerAbort?.abort();
  composerAbort = undefined;
  composer?.destroy();
  composer = undefined;
  compositionSources = undefined;
  compositionInput = undefined;
  map?.destroy();
  map = undefined;
}
function closeTools() {
  savedAreas?.destroy();
  savedAreas = undefined;
  acquisition?.destroy();
  acquisition = undefined;
  chat?.destroy();
  chat = undefined;
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
  toolSignature = "";
}
async function open(source: ByteSource) {
  closeSession();
  const opening = session;
  el("composition-scope").hidden = true;
  el("composition-single").hidden = false;
  el("composition-controls").hidden = true;
  el("tool-panels").inert = false;
  el("download").hidden = sourceLabel !== "server";
  el("cache-paused").hidden = true;
  el("map").style.visibility = "";
  document
    .querySelectorAll<HTMLElement>(".sidebar, .inspector")
    .forEach((e) => (e.inert = false));
  el("render-status").textContent = "Opening map package…";
  events = [];
  aiTransfers.clear();
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
    if (nextReader.index.manifest.composition) {
      await openComposition(source);
      return;
    }
    el<HTMLInputElement>("offline").checked = reader.offline;
    if (reader.offline)
      el("connection-label").textContent = "Using cached blocks";
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
    bindTools();
  } catch (e) {
    if (session !== opening) return;
    error(e instanceof Error ? e.message : String(e));
    el("render-status").textContent = "Could not open package";
  } finally {
    if (session === opening)
      el<HTMLButtonElement>("open-file").disabled = false;
  }
}
function bindTools() {
  if (!map || !reader?.index) return;
  closeTools();
  const m = reader.index.manifest;
  el("read-scope").textContent = "Reads from this map package.";
  el("route-sources").replaceChildren();
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    "[data-mask]",
  )) {
    checkbox.disabled = !(
      compositionSources?.flatMap((s) => s.manifest.tileLayers ?? []) ??
      m.tileLayers ??
      MAP_LAYERS
    ).some(
      (layer) => (LAYER_MASKS[layer] & Number(checkbox.dataset.mask)) !== 0,
    );
  }
  el("layer-transport").textContent = m.tileLayers
    ? "Choose any combination. Only selected layers are requested."
    : "This older package has combined geometry tiles. Switches hide geometry; convert the package with split-layers for selective downloads.";
  el("dataset-name").textContent = m.name;
  el("dataset-subtitle").textContent =
    `OSM EXTRACT · Z${m.minZoom}–${m.maxZoom}`;
  el("feature-label").textContent =
    m.featureCountKind === "tile-records" ? "Tile records" : "Features";
  const directDownload =
    reader.source instanceof HttpSource && /^https?:/.test(reader.source.url);
  el("download").hidden = !directDownload;
  if (directDownload)
    el<HTMLAnchorElement>("download").href = (reader.source as HttpSource).url;
  el<HTMLAnchorElement>("download").download =
    `${m.name.toLowerCase().replaceAll(" ", "-")}.atlas`;
  el("feature-count").textContent = number(m.features);
  el("tile-count").textContent = number(reader.index.tileCount);
  el("package-size").textContent = formatBytes(reader.index.header.fileLength);
  el("snapshot-id").textContent = `${m.snapshot.slice(0, 24)}…`;
  const heading = document.querySelector(".map-heading>span:last-child")!;
  heading.textContent = m.name;
  document.querySelector(".map-heading .eyebrow")!.textContent =
    `${((m.bounds[1] + m.bounds[3]) / 2).toFixed(1)}° N / ${((m.bounds[0] + m.bounds[2]) / 2).toFixed(1)}° E`;
  map.onSceneChange = (scene) => appearance.receiveScene(scene);
  const heights = m.buildingHeights;
  el("height-coverage").textContent = heights
    ? `${number(heights.tagged)} tagged heights · ${number(heights.estimated)} estimated from floors · ${number(heights.missing)} use fallback.${m.featureCountKind === "tile-records" ? " Counts are tile records." : ""}`
    : "This package has no height attributes. Buildings use the fallback height.";
  el("scene-badge").textContent = heights
    ? "3D · OSM heights + estimates"
    : "3D · fallback heights";
  el<HTMLInputElement>("place-labels").disabled =
    !compositionSources &&
    !m.places.length &&
    !reader.index.blocks.some((b) => b.key === "labels/places");
  map.onPickModeChange = (hint) => {
    el("pick-banner").hidden = hint === null;
    el("pick-banner").textContent = hint ?? "";
  };
  operations = new OperationSession(
    reader,
    (e) => {
      el("execution-status").textContent =
        `${e.operation} · ${executionText(e)}`;
      el("api-transfer").textContent =
        `${operations?.apiRequests ?? 0} API responses · ${formatBytes(operations?.apiBytes ?? 0)}`;
      telemetry();
    },
    compositionSources?.map((s) => ({ id: s.id, reader: s.reader })),
  );
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
      !compositionSources && !m.capabilities.includes("map-labels");
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
  acquisition = new BrowserAcquisition(
    compositionSources?.map((s) => s.reader) ?? [reader],
    () => el<HTMLInputElement>("offline").checked,
    aiTransfer,
  );
  savedAreas = new AcquisitionControls(acquisition, map);
  const currentAcquisition = acquisition;
  const updateSavedBadge = () => {
    const ready = currentAcquisition.jobs.filter((j) => j.state === "ready");
    const badge = document.getElementById("map-saved-areas");
    if (badge)
      badge.textContent = ready.length
        ? `${ready.length} saved area${ready.length === 1 ? "" : "s"} on this device · inspect coverage in Offline`
        : "No saved areas yet · keep an area for offline use";
  };
  acquisition.subscribe(updateSavedBadge);
  updateSavedBadge();
  configureOperations();
  chat = new ChatLauncher(
    map,
    compositionSources?.map((s) => s.reader) ?? [reader],
    () => new Set(operations?.enabled ?? []),
    () => el<HTMLInputElement>("offline").checked,
    aiTransfer,
    acquisition,
  );
  if (m.selection && !compositionSources) map.setSelection(m.selection.polygon);
  if (!compositionSources && m.name === "Vienna Plus") {
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
  if (compositionSources) {
    document.querySelector(".map-heading>span:last-child")!.textContent =
      `${compositionSources.length} maps · one view`;
    document.querySelector(".map-heading .eyebrow")!.textContent =
      "CLIENT COMPOSITION";
    el("dataset-name").textContent = `Tool source: ${m.name}`;
    el("read-scope").textContent = "Reads across the selected map sources.";
    el("layer-transport").textContent =
      "These display choices apply across sources. Source cards can further restrict each provider; analysis data remains independent.";
    el("height-coverage").textContent =
      "Composition uses 2D geometry. Open a source on its own in Client composer for building extrusion.";
    el("download").hidden = true;
  }
  for (const id of [
    "scene-demo",
    "scene-extrude",
    "scene-heightScale",
    "scene-fallbackHeight",
    "scene-shading",
  ]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.disabled = !!compositionSources;
  }
  document.dispatchEvent(new Event("atlas-sources-change"));
  toolSignature = `${m.snapshot}|${compositionSources?.map((s) => s.id).join("|") ?? "single"}`;
}
async function openComposition(local?: ByteSource) {
  closeSession();
  compositionInput = local;
  const opening = session;
  const abort = (composerAbort = new AbortController());
  events = [];
  aiTransfers.clear();
  compositionSources = [];
  el("cache-paused").hidden = true;
  el("map").style.visibility = "";
  document
    .querySelectorAll<HTMLElement>(".sidebar, .inspector")
    .forEach((e) => (e.inert = false));
  el("composition-scope").hidden = false;
  el("composition-single").hidden = true;
  el("composition-controls").hidden = false;
  el("error").hidden = true;
  el("query-result").hidden = true;
  el("connection-label").textContent = "Reading selected sources";
  el("tool-panels").inert = true;
  el<HTMLInputElement>("offline").checked = false;
  el("render-status").textContent = "Opening map composition…";
  try {
    const next = await CompositionMap.create(
      el<HTMLCanvasElement>("map"),
      stats,
      (_id, message) => {
        if (
          !(
            el<HTMLInputElement>("offline").checked &&
            message.includes("Not cached:")
          )
        )
          error(message);
      },
    );
    if (session !== opening) {
      next.destroy();
      return;
    }
    map = next;
    next.onSceneChange = (scene) => appearance.receiveScene(scene);
    next.setStyle(appearance.style);
    next.setScene(appearance.scene);
    setLayers();
    setLabels();
    next.setGrid(el<HTMLInputElement>("tile-grid").checked);
    const control = await createComposer(next, {
      catalog: connection.catalog,
      discovery: connection.discovery,
      delivery: connection.delivery,
      presentation: {
        get: () => ({
          style: appearance.style,
          scene: appearance.scene,
          layers: selectedLayers(),
          labels: {
            places: el<HTMLInputElement>("place-labels").checked,
            streets: el<HTMLInputElement>("street-labels").checked,
            pois: el<HTMLInputElement>("poi-labels").checked,
          },
          tools: [
            ...document.querySelectorAll<HTMLInputElement>("[data-purpose]"),
          ]
            .filter((i) => i.checked)
            .map((i) => i.dataset.purpose as any),
        }),
        apply: (value: Presentation) => {
          const p = parsePresentation(value);
          appearance.load(p.style, p.scene);
          for (const input of document.querySelectorAll<HTMLInputElement>(
            "[data-mask]",
          ))
            input.checked = p.layers.some(
              (l) => (LAYER_MASKS[l] & Number(input.dataset.mask)) !== 0,
            );
          for (const [id, on] of [
            ["place-labels", p.labels.places],
            ["street-labels", p.labels.streets],
            ["poi-labels", p.labels.pois],
          ] as const)
            el<HTMLInputElement>(id).checked = on;
          const before = [
            ...document.querySelectorAll<HTMLInputElement>("[data-purpose]"),
          ]
            .filter((i) => i.checked)
            .map((i) => i.dataset.purpose)
            .join();
          for (const input of document.querySelectorAll<HTMLInputElement>(
            "[data-purpose]",
          ))
            input.checked = p.tools.includes(input.dataset.purpose as any);
          setLayers();
          setLabels();
          if (before !== p.tools.join()) configureOperations();
        },
      },
      local,
      store: blockStore,
      signal: abort.signal,
      telemetry,
      offline: () => el<HTMLInputElement>("offline").checked,
      changed: (sources, focus) => {
        if (opening !== session) return;
        compositionSources = sources;
        if (!focus) {
          closeTools();
          document.querySelector(".map-heading>span:last-child")!.textContent =
            "No maps selected";
          el("route-sources").replaceChildren();
          telemetry();
          return;
        }
        reader = focus;
        next.reader = focus;
        const signature = `${focus.index.manifest.snapshot}|${sources.map((s) => s.id).join("|")}`;
        if (signature !== toolSignature) bindTools();
        next.setOffline(el<HTMLInputElement>("offline").checked);
        void refreshCacheView();
        telemetry();
      },
    });
    if (session !== opening) {
      control.destroy();
      return;
    }
    composer = control;
    if (!compositionSources?.length) {
      el("render-status").textContent = "Choose a source in Client composer";
      el("ready-state").textContent = "NO SOURCES";
    }
  } catch (e) {
    if (session === opening) error(String(e));
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
  if (active instanceof CompositionMap) {
    await active.refreshCacheView(enabled);
    return;
  }
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
    reopening = {
      source: reader.source,
      composition: !!compositionSources,
      compositionInput,
      center: map?.center,
      zoom: map?.zoom,
    };
  composer?.save();
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
  if (saved.composition) await openComposition(saved.compositionInput);
  else
    await open(
      saved.source instanceof HttpSource &&
        !(saved.source instanceof HashtreeSource)
        ? new HttpSource(saved.source.url, saved.source.apiUrl)
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
        composition: !!compositionSources,
        compositionInput,
        center: map?.center,
        zoom: map?.zoom,
      };
    composer?.save();
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
  if (chat && map) {
    chat.destroy();
    chat = new ChatLauncher(
      map,
      compositionSources?.map((s) => s.reader) ?? [reader],
      () => new Set(operations?.enabled ?? []),
      () => el<HTMLInputElement>("offline").checked,
      aiTransfer,
      acquisition,
    );
  }
  el("execution-hint").textContent =
    operations.mode === "server"
      ? "Receive results; the source data stays on the server."
      : "Compute here; keep the downloaded data for offline use.";
  if (compositionSources && operations.mode === "server")
    el("execution-hint").textContent =
      "Server tools use Tool source. Choose This device for cross-map routing and isochrones.";
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
  input.addEventListener("change", () => {
    configureOperations();
    document.dispatchEvent(new Event("atlas-view-change"));
  });
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
  el<HTMLInputElement>(id).onchange = () => {
    setLabels();
    document.dispatchEvent(new Event("atlas-view-change"));
  };
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
document.querySelectorAll<HTMLInputElement>("[data-mask]").forEach(
  (input) =>
    (input.onchange = () => {
      setLayers();
      document.dispatchEvent(new Event("atlas-view-change"));
    }),
);
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
const hostedMap = new URLSearchParams(location.search).get("map");
if (connection.source)
  void open(new HttpSource(connection.source, connection.api));
else if (hostedMap)
  void open(
    new HttpSource(
      connection.endpoint(
        /^[a-f0-9-]{36}$/.test(hostedMap)
          ? `maps/${hostedMap}.atlas`
          : "maps/demo.atlas",
      ),
    ),
  );
else void openComposition();
window.addEventListener("pagehide", closeSession);

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
