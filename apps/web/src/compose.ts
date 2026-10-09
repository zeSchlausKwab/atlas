import { CompositionRouting } from "./composition-routing";
import {
  CompositionMap,
  type CompositionMapSource,
} from "../../../packages/renderer/src/composition";
import { AtlasReader, HttpSource } from "../../../packages/format/src/reader";
import { BrowserBlockStore } from "../../../packages/format/src/store";
import { MAP_LAYERS, type MapLayer } from "../../../packages/format/src/index";
import {
  parseCatalog,
  httpUrl,
  type MapOffer,
} from "../../../packages/format/src/catalog";
import { STYLE_PRESETS } from "../../../packages/renderer/src/style";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`composition-${id}`) as T;
const text = (tag: string, value: string, cls?: string) => {
  const e = document.createElement(tag);
  e.textContent = value;
  if (cls) e.className = cls;
  return e;
};
const size = (n: number) =>
  n < 1048576
    ? `${(n / 1024).toFixed(1)} KiB`
    : `${(n / 1048576).toFixed(2)} MiB`;
const colors = [
  "#cc603d",
  "#327e94",
  "#76569b",
  "#397650",
  "#af7a2f",
  "#a25178",
  "#426db0",
  "#628738",
];
interface Entry {
  offer: MapOffer;
  enabled: boolean;
  layers: MapLayer[];
  labels: boolean;
  color: string;
  reader?: AtlasReader;
  opening?: Promise<void>;
  error?: string;
  card?: HTMLElement;
  status?: HTMLElement;
}
interface SavedSource {
  url: string;
  enabled: boolean;
  layers: MapLayer[];
  labels: boolean;
}
interface Recipe {
  version: 1;
  catalogs: string[];
  sources: SavedSource[];
  camera?: {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  };
  style?: string;
  coverage?: boolean;
}
const entries: Entry[] = [],
  catalogs = new Set<string>(),
  store = new BrowserBlockStore();
let map: CompositionMap;
let routing: CompositionRouting | undefined;
let recipe: Recipe | undefined;
let style = "paper";
let starting = true;
let paused = false;
const cacheChannel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("atlas-cache-control")
    : undefined;
if (cacheChannel)
  cacheChannel.onmessage = async ({ data }) => {
    if (data !== "close" || paused) return;
    paused = true;
    routing?.destroy();
    map?.destroy();
    for (const entry of entries) {
      entry.reader?.dispose();
      entry.reader = undefined;
      entry.opening = undefined;
    }
    document.querySelector<HTMLElement>(".composition-sidebar")!.inert = true;
    document.querySelector<HTMLElement>(".composition-navigation")!.inert =
      true;
    el("map").style.visibility = "hidden";
    el("status").textContent = "Paused · cache purge in another Atlas tab";
    el("status").dataset.state = "paused";
    el("detail").textContent = "Reload this page to reopen your composition.";
    try {
      await store.clear();
    } catch {
      el("detail").textContent =
        "Could not clear shared storage. Retry Purge caches in the map viewer.";
    }
  };
function message(value: string) {
  el("message").textContent = value;
}
function save(withCamera = false) {
  const value: Recipe = {
    version: 1,
    catalogs: [...catalogs],
    sources: entries.map((e) => ({
      url: e.offer.url,
      enabled: e.enabled,
      layers: e.layers,
      labels: e.labels,
    })),
    style,
    coverage: map.coverage,
  };
  if (withCamera)
    value.camera = {
      center: map.center,
      zoom: map.zoom,
      pitch: map.pitch,
      bearing: map.bearing,
    };
  history.replaceState(
    null,
    "",
    `/compose#view=${encodeURIComponent(JSON.stringify(value))}`,
  );
}
function status(entry: Entry) {
  if (!entry.status) return;
  entry.card!.dataset.enabled = String(entry.enabled);
  entry.card!.dataset.error = String(!!entry.error);
  entry.status.textContent =
    entry.error ??
    (!entry.enabled
      ? "Not subscribed"
      : entry.opening
        ? "Opening snapshot…"
        : entry.reader
          ? `Ready · ${size(entry.reader.bytesRead)} read · ${entry.reader.cacheHits} cache hits`
          : "Waiting…");
}
function sync() {
  if (paused) return;
  map.setSources(
    entries
      .filter((e) => e.enabled && e.reader && !e.opening)
      .map(
        (e) =>
          ({
            id: e.offer.url,
            manifest: e.reader!.index.manifest,
            reader: e.reader!,
            enabled: true,
            layers: e.layers,
            labels: e.labels,
            color: e.color,
          }) satisfies CompositionMapSource,
      ),
  );
  routing?.configure(
    entries
      .filter((e) => e.enabled && e.reader && !e.opening)
      .map((e) => ({ url: e.offer.url, manifest: e.reader!.index.manifest })),
  );
  const attributions = [
    ...new Set(
      entries
        .filter((e) => e.enabled)
        .map(
          (e) =>
            e.reader?.index?.manifest.source.attribution ??
            e.offer.manifest.source?.attribution ??
            "OpenStreetMap contributors",
        ),
    ),
  ];
  el("attribution").textContent = attributions.join(" · ");
  entries.forEach(status);
}
async function subscribe(entry: Entry) {
  if (paused) return;
  if (entry.reader || entry.opening) return entry.opening;
  entry.error = undefined;
  const reader = new AtlasReader(new HttpSource(entry.offer.url), undefined, {
    purposes: ["map", "labels"],
    store,
    sourceId: entry.offer.url,
    cacheBudgets: { map: 8 * 1048576, labels: 2 * 1048576 },
    directoryBudget: 2 * 1048576,
  });
  entry.reader = reader;
  let opening!: Promise<void>;
  opening = (async () => {
    try {
      await reader.open();
      if (reader.index.manifest.snapshot !== entry.offer.manifest.snapshot)
        throw new Error("Catalog snapshot changed. Reload the catalog.");
      if (!reader.index.manifest.tileLayers)
        throw new Error(
          "This legacy map needs layer-separated tiles to compose.",
        );
    } catch (e) {
      reader.dispose();
      if (entry.reader === reader) {
        entry.reader = undefined;
        entry.error = String(e);
      }
    } finally {
      if (entry.opening === opening) {
        entry.opening = undefined;
        sync();
      }
    }
  })();
  entry.opening = opening;
  status(entry);
  return opening;
}
async function enable(entry: Entry, on: boolean) {
  if (paused) return false;
  if (on && entries.filter((e) => e.enabled).length >= 8 && !entry.enabled) {
    message(
      "This prototype supports eight active maps. Switch one off before adding another.",
    );
    return false;
  }
  entry.enabled = on;
  if (!on) {
    entry.reader?.dispose();
    entry.reader = undefined;
    entry.opening = undefined;
    entry.error = undefined;
  }
  sync();
  save();
  if (on) await subscribe(entry);
  return true;
}
function buildCards() {
  el("sources").replaceChildren();
  entries.forEach((entry, index) => {
    const m = entry.offer.manifest,
      card = text("article", "", "composition-card"),
      heading = text("div", "", "composition-card-heading"),
      label = document.createElement("label"),
      check = document.createElement("input"),
      up = text("button", "↑") as HTMLButtonElement;
    entry.card = card;
    card.style.setProperty("--source-color", entry.color);
    card.setAttribute("aria-label", m.name);
    check.type = "checkbox";
    check.checked = entry.enabled;
    check.setAttribute("aria-label", `Show ${m.name}`);
    check.onchange = async () => {
      if (!(await enable(entry, check.checked))) check.checked = entry.enabled;
    };
    label.append(check, text("span", m.name));
    up.setAttribute("aria-label", `Raise priority of ${m.name}`);
    up.disabled = index === 0;
    up.onclick = () => {
      entries.splice(index, 1);
      entries.splice(index - 1, 0, entry);
      sync();
      save();
      buildCards();
    };
    heading.append(label, up);
    entry.status = text("p", "", "source-status");
    card.append(
      heading,
      text(
        "p",
        `${new URL(entry.offer.url).host} · z${m.minZoom}–${m.maxZoom} · ${size(entry.offer.bytes)} file`,
        "quiet",
      ),
      entry.status,
    );
    const layers = document.createElement("fieldset");
    layers.className = "composition-layers";
    layers.append(text("legend", "SUBSCRIBE TO DATA"));
    for (const layer of MAP_LAYERS) {
      if (!m.tileLayers?.includes(layer)) continue;
      const row = document.createElement("label"),
        input = document.createElement("input");
      input.type = "checkbox";
      input.checked = entry.layers.includes(layer);
      input.onchange = () => {
        entry.layers = input.checked
          ? [...entry.layers, layer]
          : entry.layers.filter((l) => l !== layer);
        sync();
        save();
      };
      row.append(input, text("span", layer[0]!.toUpperCase() + layer.slice(1)));
      layers.append(row);
    }
    if (m.capabilities.includes("map-labels")) {
      const row = document.createElement("label"),
        input = document.createElement("input");
      input.type = "checkbox";
      input.checked = entry.labels;
      input.onchange = () => {
        entry.labels = input.checked;
        sync();
        save();
      };
      row.append(input, text("span", "Labels"));
      layers.append(row);
    }
    card.append(layers);
    const links = text("div", "", "host-actions"),
      fit = text("button", "Go to map") as HTMLButtonElement;
    fit.onclick = async () => {
      if (!entry.enabled) {
        if (!(await enable(entry, true))) return;
        check.checked = true;
      }
      await subscribe(entry);
      map.fit([entry.offer.url]);
    };
    links.append(fit);
    for (const [label, path] of [
      [
        "Open tools ↗",
        new URL(`/?map=${encodeURIComponent(entry.offer.id)}`, entry.offer.url)
          .href,
      ],
      ["Atlas file ↗", entry.offer.url],
      ["Capabilities ↗", `${entry.offer.api}/capabilities`],
    ]) {
      const a = document.createElement("a");
      a.textContent = label!;
      a.href = path!;
      a.target = "_blank";
      a.rel = "noopener";
      links.append(a);
    }
    const details = document.createElement("details");
    details.append(
      text("summary", "Capabilities & identity"),
      text("p", m.capabilities.join(" · "), "quiet"),
      text("p", `Snapshot ${m.snapshot}`, "quiet"),
    );
    if (m.selection)
      details.append(
        text("p", `Derived from ${m.selection.parentSnapshot}`, "quiet"),
      );
    card.append(details, links);
    el("sources").append(card);
    status(entry);
  });
}
async function discover(url: string, initial = false) {
  url = httpUrl(url, location.href);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}`);
  const offers = parseCatalog(await response.json(), url);
  catalogs.add(url);
  for (const offer of offers) {
    if (entries.some((e) => e.offer.url === offer.url)) continue;
    const saved = recipe?.sources.find((s) => s.url === offer.url);
    const requested = new URLSearchParams(location.search)
      .get("maps")
      ?.split(",");
    const enabled =
      saved?.enabled ??
      (!recipe &&
        initial &&
        (requested ? requested.includes(offer.id) : offer.id !== "demo") &&
        entries.filter((e) => e.enabled).length < 8);
    entries.push({
      offer,
      enabled: enabled && entries.filter((e) => e.enabled).length < 8,
      layers: saved?.layers?.filter((l) =>
        offer.manifest.tileLayers?.includes(l),
      ) ?? [...(offer.manifest.tileLayers ?? [])],
      labels:
        saved?.labels ?? offer.manifest.capabilities.includes("map-labels"),
      color: colors[entries.length % colors.length]!,
    });
  }
}
async function start() {
  try {
    const hash = new URLSearchParams(location.hash.slice(1)).get("view");
    if (hash) {
      const saved = JSON.parse(hash);
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.catalogs) ||
        saved.catalogs.length > 16 ||
        !saved.catalogs.every((s: unknown) => typeof s === "string") ||
        !Array.isArray(saved.sources) ||
        !saved.sources.every(
          (s: SavedSource) =>
            s &&
            typeof s.url === "string" &&
            typeof s.enabled === "boolean" &&
            Array.isArray(s.layers) &&
            typeof s.labels === "boolean",
        )
      )
        throw new Error("Invalid composition link");
      recipe = saved;
    }
    map = await CompositionMap.create(
      el<HTMLCanvasElement>("map"),
      (s) => {
        const opening = entries.some((e) => e.enabled && e.opening),
          busy = starting || opening || s.loading > 0 || s.missing > 0;
        el("status").dataset.state = busy ? "loading" : "ready";
        el("status").textContent = busy
          ? "Reading selected data…"
          : s.sources
            ? `${s.sources} ${s.sources === 1 ? "source" : "sources"} in view`
            : "No selected map covers this view";
        el("detail").textContent =
          `z${s.zoom.toFixed(1)} · ${s.tiles} tiles · ${size(s.bytes)} read by active sources`;
        entries.forEach(status);
      },
      (id, error) => {
        const entry = entries.find((e) => e.offer.url === id);
        if (entry) {
          entry.error = error;
          status(entry);
        }
      },
    );
    if (paused) {
      map.destroy();
      return;
    }
    routing = new CompositionRouting(map, store);
    const failures: string[] = [];
    for (const url of new Set([
      new URL("/catalog", location.href).href,
      ...(recipe?.catalogs ?? []),
    ])) {
      try {
        await discover(url, true);
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (paused) return;
    if (recipe)
      entries.sort((a, b) => {
        const pos = (url: string) => {
          const n = recipe!.sources.findIndex((s) => s.url === url);
          return n < 0 ? 1e6 : n;
        };
        return pos(a.offer.url) - pos(b.offer.url);
      });
    else if (
      !entries.some((e) => e.enabled) &&
      !new URLSearchParams(location.search).has("maps") &&
      entries[0]
    )
      entries[0].enabled = true;
    // Prepared excerpts before the optional source package, without inferring graph compatibility.
    if (!recipe) entries.sort((a, b) => Number(b.enabled) - Number(a.enabled));
    buildCards();
    await Promise.all(entries.filter((e) => e.enabled).map(subscribe));
    if (paused) return;
    sync();
    map.fit();
    const c = recipe?.camera;
    if (
      c &&
      Array.isArray(c.center) &&
      c.center.length === 2 &&
      c.center.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
      [c.zoom, c.pitch, c.bearing].every(Number.isFinite) &&
      c.zoom >= 0 &&
      c.zoom <= 20 &&
      c.pitch >= 0 &&
      c.pitch <= 60
    ) {
      map.center = c.center;
      map.zoom = c.zoom;
      map.pitch = c.pitch;
      map.bearing = c.bearing;
    }
    map.coverage = recipe?.coverage ?? true;
    el<HTMLInputElement>("coverage").checked = map.coverage;
    if (recipe?.style && STYLE_PRESETS[recipe.style]) {
      style = recipe.style;
      map.setStyle(STYLE_PRESETS[style]!);
      el<HTMLSelectElement>("style").value = style;
    }
    starting = false;
    map.invalidate();
    message(
      failures.length
        ? failures.join(" · ")
        : `${entries.length} maps discovered. Select only the data you want to read.`,
    );
    el("fit").onclick = () => map.fit();
    el("zoom-in").onclick = () => map.zoomBy(1);
    el("zoom-out").onclick = () => map.zoomBy(-1);
    el("reset").onclick = () => map.reset();
    el<HTMLInputElement>("coverage").onchange = (e) => {
      map.coverage = (e.target as HTMLInputElement).checked;
      map.invalidate();
      save();
    };
    el<HTMLSelectElement>("style").onchange = (e) => {
      style = (e.target as HTMLSelectElement).value;
      map.setStyle(STYLE_PRESETS[style]!);
      save();
    };
    el("share").onclick = async () => {
      save(true);
      try {
        await navigator.clipboard.writeText(location.href);
        message(
          "View link copied, including sources, layers, priority and camera. Recipients need access to the same hosts.",
        );
      } catch {
        message(
          "The address bar now contains your view link. Copy it to share.",
        );
      }
    };
    el<HTMLFormElement>("catalog-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await discover(el<HTMLInputElement>("catalog").value);
        buildCards();
        save();
        message("Catalog added. Select the maps you want to display.");
      } catch (error) {
        message(
          `${error} — the host must expose an Atlas catalog and permit browser CORS reads.`,
        );
      }
    };
    window.addEventListener("pagehide", () => {
      routing?.destroy();
      map.destroy();
      entries.forEach((e) => e.reader?.dispose());
    });
  } catch (error) {
    message(String(error));
    el("status").textContent = "Composition could not start";
  }
}
void start();
