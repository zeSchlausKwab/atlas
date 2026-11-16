import {
  initialPublishedView,
  requestedMapIds,
  resolveViewSources,
} from "./composition-selection";
import {
  mapSource,
  deliveryLabel,
  FIPS_DEFAULT,
  type DeliveryChoice,
} from "./transport";
import type { DiscoveryConnection } from "./connection";
import {
  parsePresentation,
  type Presentation,
} from "../../../packages/views/src/index";
import { parseViewAnnouncement } from "../../../packages/views/src/announcement";
import type { Event as NostrEvent } from "nostr-tools/pure";
import {
  coverageFamilies,
  planCoverage,
} from "../../../packages/coverage/src/index";
import { verifyPublishedMap } from "../../../packages/hashtree/src/published-map";
import { routingCompatibility } from "../../../packages/routing/src/composition";
import { openMembers } from "../../../packages/format/src/composition";
import type { ByteSource } from "../../../packages/format/src/reader";
import type { RasterLayerViews } from "../../../packages/renderer/src/raster";
import { HashtreeSource } from "../../../packages/hashtree/src/source";
import {
  watchMaps,
  parseAnnouncement,
} from "../../../packages/hashtree/src/discovery";
import { sourceLink } from "./connection";
import {
  CompositionMap,
  type CompositionMapSource,
} from "../../../packages/renderer/src/composition";
import { AtlasReader } from "../../../packages/format/src/reader";
import { type BlockStore } from "../../../packages/format/src/store";
import { MAP_LAYERS, type MapLayer } from "../../../packages/format/src/index";
import { httpUrl, type MapOffer } from "../../../packages/format/src/catalog";
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
  rasterOpacity?: number;
  rasterLayers?: RasterLayerViews;
  root?: string;
  color: string;
  reader?: AtlasReader;
  members?: Awaited<ReturnType<typeof openMembers>>;
  local?: ByteSource;
  opening?: Promise<void>;
  error?: string;
  card?: HTMLElement;
  status?: HTMLElement;
}
interface SavedSource {
  root?: string;
  url: string;
  enabled: boolean;
  layers: MapLayer[];
  labels: boolean;
  rasterOpacity?: number;
  rasterLayers?: RasterLayerViews;
}
interface Recipe {
  version: 1;
  toolSource?: string;
  catalogs: string[];
  discovery?: Array<{ relay: string; author: string }>;
  sources: SavedSource[];
  camera?: {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  };
  presentation?: Presentation;
  publisher?: NostrEvent;
  coverage?: boolean;
}

export async function createComposer(
  map: CompositionMap,
  options: {
    catalog?: string;
    discovery?: DiscoveryConnection;
    delivery?: DeliveryChoice;
    presentation: {
      get: () => Presentation;
      apply: (value: Presentation) => void;
    };
    local?: ByteSource;
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
  const pinnedWarnings: string[] = [];
  const requestedMaps = requestedMapIds(new URLSearchParams(location.search));
  let missingPinnedView = false;
  const delivery = options.delivery ?? FIPS_DEFAULT;
  const announcements = new Map<
    string,
    { offer: MapOffer; event: NostrEvent }
  >();
  const withdrawnAt = new Map<string, number>();
  const matchesSource = (
    saved: { url: string; root?: string },
    offer: MapOffer,
  ) =>
    saved.root ? saved.root === offer.hashtree?.root : saved.url === offer.url;
  let recipe: Recipe | undefined,
    starting = true,
    paused = false;
  let focusId: string | undefined;
  let publisher: ReturnType<typeof parseViewAnnouncement> | undefined;
  const published = new Map<string, ReturnType<typeof parseViewAnnouncement>>();
  let applying = false;
  const currentSources = () =>
    entries.map((e) => ({
      url: e.offer.url,
      root: e.offer.hashtree?.root,
      enabled: e.enabled,
      layers: e.layers,
      labels: e.labels,
      rasterLayers: e.rasterLayers ?? {},
    }));
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  function refreshViewState() {
    const origin = document.getElementById("view-origin")!;
    let modified = false;
    if (publisher) {
      const baseline = publisher.recipe;
      // Unselected discovered maps do not change a publisher's composition.
      const relevant = currentSources().filter(
        (s) => s.enabled || baseline.sources.some((b) => b.root === s.root),
      );
      modified =
        !same(options.presentation.get(), baseline.presentation) ||
        !same(relevant, baseline.sources) ||
        map.coverage !== baseline.coverage;
    }
    origin.textContent = publisher
      ? `${publisher.recipe.name} · ${modified ? "Modified" : "Publisher defaults"}`
      : "Your own view · client settings";
    (document.getElementById("view-reset") as HTMLButtonElement).disabled =
      !publisher || applying;
    document.dispatchEvent(new Event("atlas-sources-change"));
  }
  const onPresentationChange = () => {
    if (!starting && !applying) {
      save();
      refreshViewState();
    }
  };
  document.addEventListener("atlas-view-change", onPresentationChange);
  const watches: Array<{ relay: string; author: string; close: () => void }> =
    [];
  const stop = () => {
    document.removeEventListener("atlas-view-change", onPresentationChange);
    for (const w of watches) w.close();
    for (const e of entries)
      if (e.reader?.source instanceof HashtreeSource) e.reader.source.clear();
    paused = true;
    entries.forEach((e) => {
      e.members?.forEach((m) => m.reader.dispose());
      e.reader?.dispose();
    });
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const active = (): CompositionMapSource[] =>
    entries
      .filter((e) => e.enabled && e.reader && !e.opening)
      .flatMap((e) =>
        (e.members?.length
          ? e.members
          : [{ id: "", reader: e.reader!, manifest: e.reader!.index.manifest }]
        ).map((m) => ({
          id: e.offer.url + (m.id ? `#member=${m.id}` : ""),
          manifest: m.manifest,
          reader: m.reader,
          enabled: true,
          layers: e.layers.filter((l) => m.manifest.tileLayers?.includes(l)),
          labels: e.labels,
          rasterOpacity: e.rasterOpacity,
          rasterLayers: Object.fromEntries(
            (m.manifest.rasters ?? []).map((r) => [
              r.id,
              e.rasterLayers?.[m.id ? `${m.id}:${r.id}` : r.id] ?? {
                enabled: true,
                opacity: 0.6,
              },
            ]),
          ),
          color: e.color,
        })),
      );
  function displayManifest(e: Entry) {
    if (!e.members?.length) return e.offer.manifest;
    return {
      ...e.offer.manifest,
      tileLayers: [
        ...new Set(e.members.flatMap((m) => m.manifest.tileLayers ?? [])),
      ],
      capabilities: [
        ...new Set(e.members.flatMap((m) => m.manifest.capabilities)),
      ],
      rasters: e.members.flatMap((m) =>
        (m.manifest.rasters ?? []).map((r) => ({
          ...r,
          id: `${m.id}:${r.id}`,
          name: `${m.manifest.name} · ${r.name}`,
        })),
      ),
    };
  }
  const focused = () => active().find((s) => s.id === focusId)?.reader;
  el("check-coverage").onclick = () => {
    try {
      const [w, s, e, n] = map.viewBounds();
      const report = planCoverage(
        {
          polygon: [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
          ],
          family: el<HTMLSelectElement>("family").value,
          zoom: Math.floor(map.zoom),
          reference: focusId,
        },
        active().map((s) => ({
          id: s.id,
          manifest: s.manifest,
          location: "remote" as const,
          verified: true,
          bytes: s.reader.index.header.fileLength,
        })),
      );
      el("coverage-report").textContent =
        Object.entries(report.totals)
          .filter(([, area]) => area > 0)
          .map(
            ([state, area]) =>
              `${state}: ${((area / report.areaM2) * 100).toFixed(1)}%`,
          )
          .join(" · ") +
        ". Verified archive scope only; empty routing cells and conflicts require directory checks in the host console.";
    } catch (error) {
      el("coverage-report").textContent = String(error);
    }
  };
  function refreshScope() {
    const sources = active();
    const family = el<HTMLSelectElement>("family"),
      previous = family.value;
    family.replaceChildren(
      ...[
        ...new Set(
          sources.flatMap((s) => coverageFamilies(s.manifest).map((f) => f.id)),
        ),
      ].map((id) => new Option(id, id)),
    );
    if ([...family.options].some((o) => o.value === previous))
      family.value = previous;
    el("coverage-report").textContent =
      "Check current view to inspect these selected sources. Archive scope does not prove route connectivity.";
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
    if (options.local || applying) return;
    const value: Recipe = {
      version: 1,
      toolSource: focusId,
      catalogs: [...catalogs],
      discovery: watches.map(({ relay, author }) => ({ relay, author })),
      sources: entries.map((e) => ({
        url: e.offer.url,
        enabled: e.enabled,
        layers: e.layers,
        labels: e.labels,
        rasterOpacity: e.rasterOpacity,
        rasterLayers: e.rasterLayers,
        root: e.offer.hashtree?.root,
      })),
      coverage: map.coverage,
      presentation: parsePresentation(options.presentation.get()),
      publisher: publisher?.event,
    };
    if (withCamera)
      value.camera = {
        center: map.center,
        zoom: map.zoom,
        pitch: map.pitch,
        bearing: map.bearing,
      };
    const link = new URL(location.href);
    link.pathname = "/";
    for (const key of ["map", "maps", "source", "api"])
      link.searchParams.delete(key);
    const fragment = new URLSearchParams(location.hash.slice(1));
    fragment.set("view", JSON.stringify(value));
    link.hash = fragment.toString();
    history.replaceState(null, "", link.href);
    refreshViewState();
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
          ? `Opening snapshot · ${entry.offer.hashtree ? deliveryLabel(entry.offer.hashtree, delivery) : "Local file"}…`
          : entry.reader
            ? `Ready · ${entry.offer.hashtree ? deliveryLabel(entry.offer.hashtree, delivery) : "Local file"} · ${size(entry.reader.bytesRead)} logical bytes · ${entry.reader.cacheHits} cache hits${entry.reader.source instanceof HashtreeSource ? ` · ${size(entry.reader.source.networkBytes)} transferred / ${entry.reader.source.requests} blob requests` : ""}`
            : "Waiting…");
  }
  function sync() {
    if (paused || applying) return;
    map.setSources(active());
    const compatibility = routingCompatibility(active().map((s) => s.manifest));
    el("routing").textContent = compatibility.message;
    refreshScope();
    if (!starting) options.changed(active(), focused());
    const attributions = [
      ...new Set(
        entries
          .filter((e) => e.enabled)
          .flatMap((e) => {
            const m = e.reader?.index?.manifest ?? e.offer.manifest;
            return [
              ...(m.capabilities.includes("vector-rendering") ||
              !m.rasters?.length
                ? [m.source.attribution]
                : []),
              ...(m.rasters ?? []).map(
                (r) => `${r.source.attribution} · ${r.source.license}`,
              ),
            ];
          }),
      ),
    ];
    const credit = document.querySelector<HTMLElement>(".map-attribution");
    if (credit) {
      credit.replaceChildren();
      attributions.forEach((text, index) => {
        if (index) credit.append(document.createTextNode(" · "));
        if (text.includes("OpenStreetMap")) {
          const link = document.createElement("a");
          link.href = "https://www.openstreetmap.org/copyright";
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = text;
          credit.append(link);
        } else credit.append(document.createTextNode(text));
      });
      credit.title = attributions.join(" · ");
    }
    entries.forEach(status);
    refreshViewState();
  }
  async function subscribe(entry: Entry) {
    if (paused) return;
    if (entry.reader || entry.opening) return entry.opening;
    entry.error = undefined;
    const reader = new AtlasReader(
      entry.local ??
        mapSource(entry.offer, delivery, { store, offline: options.offline }),
      options.telemetry,
      {
        purposes: entry.offer.manifest.composition
          ? undefined
          : ["map", "labels"],
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
          throw new Error("Published snapshot changed. Reopen discovery.");
        if (!entry.local) verifyPublishedMap(entry.offer, reader);
        entry.offer = { ...entry.offer, manifest: reader.index.manifest };
        entry.members = await openMembers(reader);
        if (entry.members.length) {
          const m = displayManifest(entry);
          const saved = recipe?.sources.find((s) =>
            matchesSource(s, entry.offer),
          );
          entry.layers =
            saved?.layers?.filter((l) => m.tileLayers?.includes(l)) ??
            m.tileLayers ??
            [];
          entry.labels = saved?.labels ?? entry.labels;
          for (const raster of m.rasters ?? []) {
            const view = saved?.rasterLayers?.[raster.id];
            entry.rasterLayers![raster.id] ??= {
              enabled: view?.enabled !== false,
              opacity: Number.isFinite(view?.opacity)
                ? Math.max(0, Math.min(1, view!.opacity))
                : (entry.rasterOpacity ?? 0.6),
            };
          }
          buildCards();
        }
        if (!reader.index.manifest.tileLayers)
          throw new Error(
            "This legacy map needs layer-separated tiles to compose.",
          );
      } catch (e) {
        entry.members?.forEach((m) => m.reader.dispose());
        entry.members = undefined;
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
      if (entry.reader?.source instanceof HashtreeSource)
        entry.reader.source.clear();
      entry.members?.forEach((m) => m.reader.dispose());
      entry.members = undefined;
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
      const m = displayManifest(entry),
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
      check.setAttribute("aria-label", `Use ${m.name}`);
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
          `${entry.offer.url.startsWith("htree:") ? "Content root " + entry.offer.hashtree!.root.slice(0, 12) + "…" : new URL(entry.offer.url).host} · z${m.minZoom}–${m.maxZoom} · ${size(entry.offer.bytes)} file`,
          "quiet",
        ),
        entry.status,
      );
      card.append(
        text(
          "p",
          entry.local
            ? "Local file · self-contained"
            : `Hashtree · ${entry.offer.hashtree!.root.slice(0, 16)}…`,
          "quiet",
        ),
      );
      const layers = document.createElement("fieldset");
      layers.className = "composition-layers";
      layers.append(text("legend", "Display layers from this source"));
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
      for (const raster of m.rasters ?? []) {
        const state = entry.rasterLayers![raster.id]!,
          row = text("div", "", "composer-raster"),
          toggle = document.createElement("input"),
          label = text("label", ""),
          dialLabel = text("label", "Opacity", "composer-raster-opacity"),
          dial = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = state.enabled;
        label.append(toggle, document.createTextNode(raster.name));
        dial.setAttribute("aria-label", `${raster.name} opacity`);
        dial.type = "range";
        dial.min = "0";
        dial.max = "1";
        dial.step = "0.05";
        dial.value = String(state.opacity);
        dial.disabled = !state.enabled;
        toggle.onchange = () => {
          state.enabled = toggle.checked;
          dial.disabled = !state.enabled;
          sync();
          save();
        };
        dial.oninput = () => {
          state.opacity = Number(dial.value);
          sync();
          save();
        };
        dialLabel.append(dial);
        row.append(label, dialLabel);
        layers.append(row);
      }
      card.append(
        layers,
        text(
          "p",
          "These switches control display reads. Search, routing and analysis use the independent on-demand choices in Layers & data.",
          "quiet",
        ),
      );
      const links = text("div", "", "host-actions"),
        fit = text("button", "Go to map") as HTMLButtonElement;
      fit.onclick = async () => {
        if (!entry.enabled) {
          if (!(await enable(entry, true))) return;
          check.checked = true;
        }
        await subscribe(entry);
        map.fit(
          active()
            .filter(
              (s) =>
                s.id === entry.offer.url ||
                s.id.startsWith(`${entry.offer.url}#member=`),
            )
            .map((s) => s.id),
        );
      };
      links.append(fit);
      for (const [label, path] of entry.local
        ? []
        : [
            [
              "Open this map only ↗",
              sourceLink(entry.offer.url, entry.offer.api, entry.offer.id),
            ],
            ...(/^https?:/.test(entry.offer.url)
              ? [["Atlas file ↗", entry.offer.url]]
              : []),
            ...(entry.offer.api && delivery.transport === "http"
              ? [["Capabilities ↗", `${entry.offer.api}/capabilities`]]
              : []),
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
      if (m.transport) {
        const f = m.transport.federation;
        details.append(
          text(
            "p",
            f
              ? `OSM revision ${f.sourceRevision} · ${f.contract} · ${Object.keys(m.transport.profiles).join(", ")}`
              : "Legacy routing · requires the same compiled graph",
            "quiet",
          ),
        );
      }
      if (m.selection)
        details.append(
          text("p", `Derived from ${m.selection.parentSnapshot}`, "quiet"),
        );
      card.append(details, links);
      el("sources").append(card);
      status(entry);
    });
  }
  function addOffer(offer: MapOffer, initial = false) {
    if (!offer.hashtree) return;
    const pinned = recipe?.sources.find((s) => matchesSource(s, offer));
    if (pinned?.root && pinned.root !== offer.hashtree.root) {
      const warning = `Pinned revision of ${offer.manifest.name} is unavailable. Start a new composition to use its replacement.`;
      pinnedWarnings.push(warning);
      message(warning);
      return;
    }
    const mirror =
      offer.hashtree &&
      entries.find(
        (e) =>
          e.offer.hashtree?.root === offer.hashtree!.root &&
          e.offer.manifest.snapshot === offer.manifest.snapshot,
      );
    if (mirror) {
      mirror.offer.hashtree!.providers = [
        ...new Set([
          ...mirror.offer.hashtree!.providers,
          ...offer.hashtree!.providers,
        ]),
      ].slice(0, 8);
      mirror.offer.hashtree!.fips = [
        ...new Map(
          [
            ...(mirror.offer.hashtree!.fips ?? []),
            ...(offer.hashtree!.fips ?? []),
          ].map((p) => [`${p.peerId}:${p.servicePort ?? 39018}`, p]),
        ).values(),
      ].slice(0, 8);
      if (mirror.reader?.source instanceof HashtreeSource) {
        mirror.reader.source.addProviders(offer.hashtree!.providers);
        mirror.reader.source.tree.fips = mirror.offer.hashtree!.fips;
      }
      return;
    }
    const existing = entries.find((e) => e.offer.url === offer.url);
    if (existing) {
      if (
        existing.offer.manifest.snapshot === offer.manifest.snapshot &&
        offer.hashtree
      ) {
        existing.offer.hashtree = offer.hashtree;
      } else if (existing.offer.manifest.snapshot !== offer.manifest.snapshot)
        message(
          "A new map revision is available. Reload to select it; this session stays pinned.",
        );
      return;
    }
    const saved = recipe?.sources.find((s) => matchesSource(s, offer));
    const requested = requestedMaps;
    const enabled =
      saved?.enabled ??
      (!recipe &&
        initial &&
        (requested
          ? requested.includes(offer.id) ||
            requested.includes(offer.hashtree.root)
          : offer.id !== "demo") &&
        entries.filter((e) => e.enabled).length < 8);
    entries.push({
      offer,
      enabled: enabled && entries.filter((e) => e.enabled).length < 8,
      layers: saved?.layers?.filter((l) =>
        offer.manifest.tileLayers?.includes(l),
      ) ?? [...(offer.manifest.tileLayers ?? [])],
      labels:
        saved?.labels ?? offer.manifest.capabilities.includes("map-labels"),
      rasterOpacity: Number.isFinite(saved?.rasterOpacity)
        ? Math.max(0, Math.min(1, saved!.rasterOpacity!))
        : 0.6,
      rasterLayers: Object.fromEntries(
        (offer.manifest.rasters ?? []).map((r) => {
          const v = saved?.rasterLayers?.[r.id];
          return [
            r.id,
            {
              enabled: v?.enabled !== false,
              opacity: Number.isFinite(v?.opacity)
                ? Math.max(0, Math.min(1, v!.opacity))
                : Number.isFinite(saved?.rasterOpacity)
                  ? Math.max(0, Math.min(1, saved!.rasterOpacity!))
                  : 0.6,
            },
          ];
        }),
      ),
      root: offer.hashtree.root,
      color: colors[entries.length % colors.length]!,
    });
  }
  async function listen(relay: string, author: string) {
    const previous = watches.findIndex(
      (w) => w.relay === relay && w.author === author,
    );
    if (previous >= 0) {
      watches[previous]!.close();
      watches.splice(previous, 1);
    }
    if (watches.length >= 8)
      throw new Error("At most eight discovery subscriptions");
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const close = await watchMaps(
      relay,
      [author],
      (offer, event) => {
        if (paused) return;
        const identity = `${event.pubkey}:${offer.id}`;
        if ((withdrawnAt.get(identity) ?? -1) >= event.created_at) return;
        const previous = announcements.get(identity)?.event;
        if (
          previous &&
          (previous.created_at > event.created_at ||
            (previous.created_at === event.created_at &&
              previous.id <= event.id))
        )
          return;
        announcements.set(identity, { offer, event });
        addOffer(offer, true);
        const refreshed = entries.find(
          (e) => e.offer.hashtree?.root === offer.hashtree?.root,
        );
        if (refreshed) {
          const publications = [...announcements.values()].filter(
            (a) => a.offer.hashtree?.root === offer.hashtree?.root,
          );
          refreshed.offer.hashtree!.providers = [
            ...new Set(
              publications.flatMap((a) => a.offer.hashtree!.providers),
            ),
          ].slice(0, 8);
          refreshed.offer.hashtree!.fips = [
            ...new Map(
              publications
                .flatMap((a) => a.offer.hashtree!.fips ?? [])
                .map((p) => [
                  `${p.peerId}:${p.servicePort ?? 39018}:${p.rpcPort ?? "none"}`,
                  p,
                ]),
            ).values(),
          ].slice(0, 8);
          if (refreshed.reader?.source instanceof HashtreeSource)
            Object.assign(refreshed.reader.source.tree, {
              providers: refreshed.offer.hashtree!.providers,
              fips: refreshed.offer.hashtree!.fips,
            });
        }
        buildCards();
        if (!starting)
          void Promise.all(
            entries.filter((e) => e.enabled && !e.reader).map(subscribe),
          );
      },
      options.signal,
      message,
      (view) => {
        if (paused || published.has(view.event.id)) return;
        const revisions = [...published.values()].filter(
          (p) =>
            p.event.pubkey === view.event.pubkey &&
            p.recipe.id === view.recipe.id,
        );
        if (
          revisions.some(
            (p) =>
              p.event.created_at > view.event.created_at ||
              (p.event.created_at === view.event.created_at &&
                p.event.id < view.event.id),
          )
        )
          return;
        for (const old of revisions) {
          published.delete(old.event.id);
          if (picker.value !== old.event.id)
            [...picker.options]
              .find((option) => option.value === old.event.id)
              ?.remove();
        }
        published.set(view.event.id, view);
        picker.add(
          new Option(
            `${view.recipe.name} · ${view.event.pubkey.slice(0, 8)}`,
            view.event.id,
          ),
        );
        // Live updates offer a choice; an already active pinned view is never replaced.
      },
      {
        ready: markReady,
        withdrawn: (id, publisher, deletion) => {
          const identity = `${publisher}:${id}`;
          const old = announcements.get(identity);
          if ((old?.event.created_at ?? -1) > deletion.created_at) return;
          withdrawnAt.set(
            identity,
            Math.max(withdrawnAt.get(identity) ?? -1, deletion.created_at),
          );
          announcements.delete(identity);
          if (!old) return;
          const remaining = [...announcements.values()].filter(
            (a) => a.offer.hashtree?.root === old.offer.hashtree?.root,
          );
          const entry = entries.find(
            (e) => e.offer.hashtree?.root === old.offer.hashtree?.root,
          );
          if (!entry) return;
          if (!remaining.length) {
            void enable(entry, false).then(() => {
              entry.error =
                "Publisher withdrew this map. Choose another published revision.";
              buildCards();
              sync();
            });
          } else {
            entry.offer.hashtree!.providers = [
              ...new Set(remaining.flatMap((a) => a.offer.hashtree!.providers)),
            ];
            entry.offer.hashtree!.fips = [
              ...new Map(
                remaining
                  .flatMap((a) => a.offer.hashtree!.fips ?? [])
                  .map((p) => [`${p.peerId}:${p.servicePort ?? 39018}`, p]),
              ).values(),
            ];
            if (entry.reader?.source instanceof HashtreeSource)
              Object.assign(entry.reader.source.tree, {
                providers: entry.offer.hashtree!.providers,
                fips: entry.offer.hashtree!.fips,
              });
          }
        },
      },
    );
    watches.push({ relay, author, close });
    // EOSE establishes an initial catalog, not global absence. The subscription stays live.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<void>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  "Discovery is taking longer than expected; the relay remains connected for late offers.",
                ),
              ),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }
  async function discover(url: string, initial = false) {
    url = new URL("/discovery", httpUrl(url, location.href)).href;
    const response = await fetch(url, {
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok)
      throw new Error(`Discovery returned HTTP ${response.status}`);
    const info = await response.json();
    if (
      !/^[a-f0-9]{64}$/.test(info.pubkey) ||
      !Array.isArray(info.publications)
    )
      throw new Error("Invalid discovery identity");
    options.signal.throwIfAborted();
    catalogs.add(url);
    for (const event of info.publications) {
      const parsed = parseAnnouncement(event);
      if (parsed.event.pubkey !== info.pubkey)
        throw new Error("Publisher identity mismatch");
      announcements.set(`${parsed.event.pubkey}:${parsed.offer.id}`, parsed);
      addOffer(parsed.offer, initial);
    }
    el<HTMLInputElement>("relay").value = info.relay;
    el<HTMLInputElement>("publisher").value = info.pubkey;
    // The HTTP response already contains signed offers. Direct inspection must
    // not wait for a WebSocket relay; peer discovery remains a FIPS concern.
    if (delivery.transport === "fips") await listen(info.relay, info.pubkey);
  }

  const hash = new URLSearchParams(location.hash.slice(1)).get("view");
  if (hash && !options.local) {
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
    if (saved.presentation)
      saved.presentation = parsePresentation(saved.presentation);
    if (saved.publisher) publisher = parseViewAnnouncement(saved.publisher);
    recipe = saved;
  }
  const failures: string[] = [];
  const picker = document.getElementById("publisher-view") as HTMLSelectElement;
  picker.replaceChildren(new Option("Your own composition", ""));
  if (!options.local && options.catalog) {
    try {
      const base = new URL(options.catalog);
      const response = await fetch(new URL("/views", base), {
        signal: options.signal,
        cache: "no-store",
      });
      if (response.ok) {
        const info = await response.json();
        if (
          !/^[a-f0-9]{64}$/.test(info.pubkey) ||
          !Array.isArray(info.views) ||
          info.views.length > 100
        )
          throw new Error("Invalid published views");
        for (const event of info.views) {
          const parsed = parseViewAnnouncement(event, info.pubkey);
          published.set(event.id, parsed);
          picker.add(new Option(parsed.recipe.name, event.id));
        }
        const requested = recipe
          ? null
          : new URLSearchParams(location.search).get("viewRecipe");
        let chosen = requested
          ? published.get(requested)
          : [...published.values()].find(
              (p) => p.recipe.id === info.defaultView,
            );
        if (requested && !chosen) {
          if (!/^[a-f0-9]{64}$/.test(requested))
            throw new Error("Invalid view revision");
          const r = await fetch(new URL(`/views/${requested}`, base), {
            signal: options.signal,
          });
          if (!r.ok) throw new Error("Pinned view revision is unavailable");
          chosen = parseViewAnnouncement(await r.json(), info.pubkey);
          if (chosen.event.id !== requested)
            throw new Error("Pinned view revision mismatch");
          published.set(chosen.event.id, chosen);
          picker.add(
            new Option(
              chosen.recipe.name + " · pinned revision",
              chosen.event.id,
            ),
          );
        }
        if (!recipe && chosen && (requested || !requestedMaps)) {
          publisher = chosen;
          recipe = {
            ...chosen.recipe,
            catalogs: [options.catalog],
            publisher: chosen.event,
          };
        }
      } else if (new URLSearchParams(location.search).has("viewRecipe"))
        throw new Error("Published view service unavailable");
    } catch (error) {
      if (new URLSearchParams(location.search).has("viewRecipe")) throw error;
      failures.push(`Publisher defaults unavailable: ${String(error)}`);
    }
  }
  if (publisher && !published.has(publisher.event.id)) {
    published.set(publisher.event.id, publisher);
    picker.add(
      new Option(
        publisher.recipe.name + " · shared revision",
        publisher.event.id,
      ),
    );
  }
  picker.value = publisher?.event.id ?? "";
  // Apply before opening readers: a publisher's hidden layer must never be fetched first.
  if (recipe?.presentation) options.presentation.apply(recipe.presentation);

  if (options.local) {
    recipe = undefined;
    const reader = await new AtlasReader(
      options.local,
      options.telemetry,
    ).open();
    const manifest = reader.index.manifest;
    reader.dispose();
    entries.push({
      offer: {
        id: "local",
        url: new URL("local.atlas", location.href).href,
        api: "",
        bytes: 0,
        manifest,
      },
      enabled: true,
      layers: manifest.tileLayers ?? [],
      labels: true,
      rasterLayers: {},
      color: colors[0]!,
      local: options.local,
    });
  }

  for (const url of new Set(
    options.local
      ? []
      : [
          ...(options.catalog ? [options.catalog] : []),
          ...(recipe?.catalogs ?? []),
        ],
  )) {
    try {
      await discover(url, true);
    } catch (e) {
      failures.push(String(e));
    }
  }
  for (const d of [
    ...(options.discovery?.relays.map((relay) => ({
      relay,
      author: options.discovery!.publisher,
    })) ?? []),
    ...(recipe?.discovery ?? []),
  ]
    .filter(
      (d, i, all) =>
        all.findIndex((x) => x.relay === d.relay && x.author === d.author) ===
        i,
    )
    .slice(0, 8)) {
    try {
      await listen(d.relay, d.author);
    } catch (e) {
      failures.push(String(e));
    }
  }
  options.signal.throwIfAborted();
  if (
    !recipe &&
    options.discovery &&
    (new URLSearchParams(location.search).has("viewRecipe") || !requestedMaps)
  ) {
    const requested = new URLSearchParams(location.search).get("viewRecipe");
    try {
      const selected = initialPublishedView(
        [...published.values()],
        options.discovery.publisher,
        requested,
      );
      if (selected) {
        publisher = selected;
        recipe = {
          ...selected.recipe,
          catalogs: [],
          publisher: selected.event,
        };
        options.presentation.apply(selected.recipe.presentation);
        picker.value = selected.event.id;
        const selection = resolveViewSources(
          selected.recipe,
          entries.map((e) => e.offer),
        );
        for (const e of entries) {
          const state = selection.available.get(e.offer);
          e.enabled = state?.enabled ?? false;
          if (state) {
            e.layers = [...state.layers];
            e.labels = state.labels;
            e.rasterLayers = structuredClone(state.rasterLayers ?? {});
          }
        }
        if (selection.missing.length)
          failures.push(
            `Publisher view partially available: ${selection.missing.length} pinned source${selection.missing.length === 1 ? " is" : "s are"} missing. Only available selected sources are opened.`,
          );
      }
    } catch (error) {
      missingPinnedView = true;
      for (const entry of entries) entry.enabled = false;
      failures.push(String(error));
    }
  }

  if (recipe)
    entries.sort((a, b) => {
      const pos = (offer: MapOffer) => {
        const n = recipe!.sources.findIndex((s) => matchesSource(s, offer));
        return n < 0 ? 1e6 : n;
      };
      return pos(a.offer) - pos(b.offer);
    });
  else {
    if (
      !entries.some((e) => e.enabled) &&
      !missingPinnedView &&
      !requestedMaps &&
      entries[0]
    )
      entries[0].enabled = true;
    entries.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }
  if (recipe)
    for (const source of recipe.sources.filter((s) => s.enabled)) {
      if (!entries.some((e) => matchesSource(source, e.offer)))
        failures.push(
          `Pinned source unavailable: ${source.url}. It has not been replaced.`,
        );
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
      ...options.presentation.get().scene,
      pitch: c.pitch,
      bearing: c.bearing,
    });
  }
  map.coverage = recipe?.coverage ?? true;
  el<HTMLInputElement>("coverage").checked = map.coverage;
  map.invalidate();
  refreshViewState();
  message(
    failures.length || pinnedWarnings.length
      ? [...failures, ...pinnedWarnings].join(" · ")
      : `${entries.length} maps discovered. Choose sources, then use the normal Route and Explore tabs.`,
  );
  if (options.discovery) {
    el<HTMLInputElement>("relay").value = options.discovery.relays[0]!;
    el<HTMLInputElement>("publisher").value = options.discovery.publisher;
  }
  el<HTMLFormElement>("nostr-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await listen(
        el<HTMLInputElement>("relay").value,
        el<HTMLInputElement>("publisher").value,
      );
      save();
    } catch (e) {
      message(String(e));
    }
  };
  el("fit").onclick = () => map.fit();
  el<HTMLInputElement>("coverage").onchange = (e) => {
    map.coverage = (e.target as HTMLInputElement).checked;
    map.invalidate();
    save();
  };
  el("share").onclick = async () => {
    if (options.local) {
      message("Share the .atlas file to reopen this local composition.");
      return;
    }
    save(true);
    try {
      await navigator.clipboard.writeText(location.href);
      message(
        "View link copied: pinned sources, appearance, data choices and camera.",
      );
    } catch {
      message("Copy the address bar to share this composition.");
    }
  };
  async function applyPublished(id: string) {
    if (!id) {
      publisher = undefined;
      recipe = undefined;
      const url = new URL(location.href);
      url.searchParams.delete("viewRecipe");
      history.replaceState(null, "", url);
      save();
      return;
    }
    // A newer announcement must not invalidate Reset for the active pinned revision.
    const selected =
      published.get(id) ?? (publisher?.event.id === id ? publisher : undefined);
    if (!selected) return;
    const missing = selected.recipe.sources.filter(
      (s) =>
        s.enabled && !entries.some((e) => e.offer.hashtree?.root === s.root),
    );
    if (missing.length) {
      message(
        "Cannot apply this view: one or more pinned source revisions are unavailable. Your current view is unchanged.",
      );
      picker.value = publisher?.event.id ?? "";
      return;
    }
    applying = true;
    refreshViewState();
    try {
      // Remove old renderer subscriptions before applying settings to avoid transient reads.
      map.setSources([]);
      options.changed([]);
      for (const entry of entries) await enable(entry, false);
      publisher = selected;
      recipe = {
        ...selected.recipe,
        catalogs: [...catalogs],
        publisher: selected.event,
      };
      options.presentation.apply(selected.recipe.presentation);
      entries.sort((a, b) => {
        const pos = (e: Entry) => {
          const i = selected.recipe.sources.findIndex(
            (s) => s.root === e.offer.hashtree?.root,
          );
          return i < 0 ? 1e6 : i;
        };
        return pos(a) - pos(b);
      });
      for (const entry of entries) {
        const state = selected.recipe.sources.find(
          (s) => s.root === entry.offer.hashtree?.root,
        );
        if (state) {
          entry.layers = [...state.layers];
          entry.labels = state.labels;
          entry.rasterLayers = structuredClone(state.rasterLayers ?? {});
          entry.enabled = state.enabled;
        }
      }
      await Promise.all(entries.filter((e) => e.enabled).map(subscribe));
      map.coverage = selected.recipe.coverage;
      el<HTMLInputElement>("coverage").checked = map.coverage;
      applying = false;
      sync();
      map.fit();
      if (selected.recipe.camera) {
        map.center = selected.recipe.camera.center;
        map.zoom = selected.recipe.camera.zoom;
        map.setScene({
          ...selected.recipe.presentation.scene,
          pitch: selected.recipe.camera.pitch,
          bearing: selected.recipe.camera.bearing,
        });
      }
      picker.value = id;
      buildCards();
      applying = false;
      save(true);
      message(
        "Publisher view applied. Tools remain on demand; nothing is bulk-downloaded.",
      );
    } finally {
      applying = false;
      refreshViewState();
    }
  }
  picker.onchange = () =>
    void applyPublished(picker.value).catch((e) => message(String(e)));
  document.getElementById("view-reset")!.onclick = () =>
    void applyPublished(publisher?.event.id ?? "").catch((e) =>
      message(String(e)),
    );
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
