import { sourceLink } from "./connection";
import {
  CompositionMap,
  type CompositionMapSource,
} from "../../../packages/renderer/src/composition";
import { AtlasReader, HttpSource } from "../../../packages/format/src/reader";
import { type BlockStore } from "../../../packages/format/src/store";
import { MAP_LAYERS, type MapLayer } from "../../../packages/format/src/index";
import {
  parseCatalog,
  httpUrl,
  type MapOffer,
} from "../../../packages/format/src/catalog";
import type { ReadEvent } from "../../../packages/format/src/reader";
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
  toolSource?: string;
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

/** Preserve HttpSource identity/API discovery while gating even initial header reads. */
class SubscriptionSource extends HttpSource {
  constructor(
    url: string,
    private readonly cacheOnly: () => boolean,
    api?: string,
  ) {
    super(url, api);
  }
  override read(start: number, end: number, signal?: AbortSignal) {
    if (this.cacheOnly())
      return Promise.reject(
        new TypeError(
          "Network disabled by Cache only; this source must already be cached.",
        ),
      );
    return super.read(start, end, signal);
  }
}
export async function createComposer(
  map: CompositionMap,
  options: {
    catalog: string;
    store?: BlockStore;
    signal: AbortSignal;
    telemetry: (event: ReadEvent) => void;
    offline: () => boolean;
    changed: (sources: CompositionMapSource[], focused?: AtlasReader) => void;
  },
) {
  const entries: Entry[] = [],
    catalogs = new Set<string>(),
    store = options.store;
  let recipe: Recipe | undefined,
    starting = true,
    paused = false;
  let focusId: string | undefined;
  const stop = () => {
    paused = true;
    entries.forEach((e) => e.reader?.dispose());
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const active = (): CompositionMapSource[] =>
    entries
      .filter((e) => e.enabled && e.reader && !e.opening)
      .map((e) => ({
        id: e.offer.url,
        manifest: e.reader!.index.manifest,
        reader: e.reader!,
        enabled: true,
        layers: e.layers,
        labels: e.labels,
        color: e.color,
      }));
  const focused = () => active().find((s) => s.id === focusId)?.reader;
  function refreshScope() {
    const sources = active();
    if (!sources.some((s) => s.id === focusId)) focusId = sources[0]?.id;
    const select = document.getElementById("tool-source") as HTMLSelectElement;
    select.replaceChildren(
      ...sources.map((s) => new Option(s.manifest.name, s.id)),
    );
    select.value = focusId ?? "";
    select.disabled = !sources.length;
    document.getElementById("source-scope-hint")!.textContent = sources.length
      ? "Search, queries, extraction, offline exports and server tools use this source. Client routes and isochrones use all compatible selected maps."
      : "Select a map in Client composer to enable tools.";
    document.getElementById("tool-panels")!.inert = !sources.length;
    if (focused()) map.reader = focused()!;
  }
  function message(value: string) {
    el("message").textContent = value;
  }
  function save(withCamera = false) {
    const value: Recipe = {
      version: 1,
      toolSource: focusId,
      catalogs: [...catalogs],
      sources: entries.map((e) => ({
        url: e.offer.url,
        enabled: e.enabled,
        layers: e.layers,
        labels: e.labels,
      })),
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
      `/#view=${encodeURIComponent(JSON.stringify(value))}`,
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
    refreshScope();
    if (!starting) options.changed(active(), focused());
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
    document
      .querySelector<HTMLElement>(".attribution")
      ?.setAttribute("title", attributions.join(" · "));
    entries.forEach(status);
  }
  async function subscribe(entry: Entry) {
    if (paused) return;
    if (entry.reader || entry.opening) return entry.opening;
    entry.error = undefined;
    const reader = new AtlasReader(
      new SubscriptionSource(entry.offer.url, options.offline, entry.offer.api),
      options.telemetry,
      {
        purposes: ["map", "labels"],
        store,
        sourceId: entry.offer.url,
        cacheBudgets: {
          map: 8 * 1048576,
          labels: 2 * 1048576,
          routing: 8 * 1048576,
        },
        directoryBudget: 2 * 1048576,
      },
    );
    entry.reader = reader;
    let opening!: Promise<void>;
    opening = (async () => {
      try {
        await reader.open();
        reader.offline = options.offline();
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
        if (!(await enable(entry, check.checked)))
          check.checked = entry.enabled;
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
        row.append(
          input,
          text("span", layer[0]!.toUpperCase() + layer.slice(1)),
        );
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
        ["Open this map only ↗", sourceLink(entry.offer.url, entry.offer.api)],
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
    const response = await fetch(url, {
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok)
      throw new Error(`Catalog returned HTTP ${response.status}`);
    const offers = parseCatalog(await response.json(), url);
    options.signal.throwIfAborted();
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
  const failures: string[] = [];
  for (const url of new Set([options.catalog, ...(recipe?.catalogs ?? [])])) {
    try {
      await discover(url, true);
    } catch (e) {
      failures.push(String(e));
    }
  }
  options.signal.throwIfAborted();
  if (recipe)
    entries.sort((a, b) => {
      const pos = (url: string) => {
        const n = recipe!.sources.findIndex((s) => s.url === url);
        return n < 0 ? 1e6 : n;
      };
      return pos(a.offer.url) - pos(b.offer.url);
    });
  else {
    if (
      !entries.some((e) => e.enabled) &&
      !new URLSearchParams(location.search).has("maps") &&
      entries[0]
    )
      entries[0].enabled = true;
    entries.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }
  buildCards();
  await Promise.all(entries.filter((e) => e.enabled).map(subscribe));
  options.signal.throwIfAborted();
  starting = false;
  // Prefer display priority for the initial tool scope, independent of response timing.
  focusId = active().some((s) => s.id === recipe?.toolSource)
    ? recipe!.toolSource
    : active()[0]?.id;
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
    map.setScene({
      pitch: c.pitch,
      bearing: c.bearing,
      extrude: false,
      heightScale: 1,
      fallbackHeight: 12,
      shading: 0.8,
    });
  }
  map.coverage = recipe?.coverage ?? true;
  el<HTMLInputElement>("coverage").checked = map.coverage;
  map.invalidate();
  message(
    failures.length
      ? failures.join(" · ")
      : `${entries.length} maps discovered. Choose sources, then use the normal Route and Explore tabs.`,
  );
  el("fit").onclick = () => map.fit();
  el<HTMLInputElement>("coverage").onchange = (e) => {
    map.coverage = (e.target as HTMLInputElement).checked;
    map.invalidate();
    save();
  };
  el("share").onclick = async () => {
    save(true);
    try {
      await navigator.clipboard.writeText(location.href);
      message("View link copied: sources, layers, priority and camera.");
    } catch {
      message("Copy the address bar to share this composition.");
    }
  };
  el<HTMLFormElement>("catalog-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await discover(el<HTMLInputElement>("catalog").value);
      buildCards();
      save();
      message("Catalog added. Select the maps you want to display.");
    } catch (e) {
      message(
        `${e} — the host must expose an Atlas catalog and permit browser CORS reads.`,
      );
    }
  };
  document.getElementById("tool-source")!.onchange = (e) => {
    focusId = (e.target as HTMLSelectElement).value;
    sync();
    save();
  };
  return {
    active,
    focused,
    updateStatus: () => entries.forEach(status),
    save: () => save(true),
    destroy() {
      options.signal.removeEventListener("abort", stop);
      stop();
    },
  };
}
export type ClientComposer = Awaited<ReturnType<typeof createComposer>>;
