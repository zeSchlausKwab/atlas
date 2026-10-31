import {
  defaultPresentation,
  parseViewRecipe,
  TOOL_PURPOSES,
  type ToolPurpose,
  type ViewRecipe,
} from "../../../packages/views/src/index";
import { parseViewAnnouncement } from "../../../packages/views/src/announcement";
import { STYLE_PRESETS } from "../../../packages/renderer/src/style";
import { MAP_LAYERS, type MapLayer } from "../../../packages/format/src/index";
import type { MapOffer } from "../../../packages/format/src/catalog";
import { openClient } from "./client-link";
const node = (tag: string, text = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
const captions: Record<string, string> = {
  land: "Landscape",
  water: "Water",
  roads: "Roads & paths",
  railways: "Railways",
  buildings: "Buildings",
  peaks: "Peaks",
  routing: "Routing & isochrones",
  search: "Search & geocoding",
  queries: "Queries",
  features: "Feature extraction & analysis",
};
export async function startViews() {
  const section = document.createElement("section");
  section.className = "publisher-views";
  section.innerHTML = `<div class="section-heading"><div><p class="eyebrow">YOUR DATA / THEIR FIRST VIEW</p><h2>Published views</h2></div><button id="views-refresh" type="button">Refresh</button></div>
    <p>Recommend a composition, its appearance and the data loaded on demand. Clients can change every choice. Publishing a view leaves your map files unchanged.</p>
    <div id="views-list" class="host-actions"></div>
    <details id="view-editor"><summary>Create or edit a view</summary><form id="view-form">
      <div class="view-form-grid"><label>View name<input id="view-name" required maxlength="120" value="Explore this place"></label><label>Appearance<select id="view-paint"></select></label></div>
      <p class="quiet">Select sources in display priority order. Their Hashtree revisions are pinned when you publish. Publish new maps with Hashtree first.</p>
      <div id="view-sources"></div>
      <div class="view-form-grid"><fieldset id="view-layers"><legend>Shown on opening</legend></fieldset><fieldset id="view-tools"><legend>Available on demand</legend></fieldset></div>
      <label><input id="view-labels" type="checkbox" checked> Show place, street and POI labels where available</label>
      <label><input id="view-imagery" type="checkbox"> Show imagery on opening (60% opacity)</label>
      <label><input id="view-default" type="checkbox" checked> Use as this host’s default view</label>
      <p class="quiet">Hidden display layers are not requested. Enabled tools wait until used. No bulk download or offline save is started by this recipe.</p>
      <div class="host-actions"><button type="submit">Publish view</button><button id="view-new" type="button">New view</button></div>
    </form></details><p id="view-status" role="status"></p>`;
  document.getElementById("library")!.prepend(section);
  const el = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  for (const [id, style] of Object.entries(STYLE_PRESETS))
    el<HTMLSelectElement>("view-paint").add(new Option(style.name, id));
  for (const [target, values] of [
    ["view-layers", MAP_LAYERS],
    ["view-tools", TOOL_PURPOSES],
  ] as const)
    for (const id of values) {
      const label = node("label"),
        check = document.createElement("input");
      check.type = "checkbox";
      check.checked = true;
      check.value = id;
      label.append(check, document.createTextNode(captions[id] ?? id));
      el(target).append(label);
    }
  let maps: MapOffer[] = [],
    editing: ViewRecipe | undefined;
  let sourceOrder: string[] = [];
  let selected = new Set<string>();
  const changed = new Set<string>();
  for (const id of ["view-paint", "view-labels", "view-imagery"])
    el(id).addEventListener("change", () => changed.add(id));
  const checks = (id: string) => [
    ...el(id).querySelectorAll<HTMLInputElement>("input"),
  ];
  function drawSources() {
    const list = el("view-sources");
    list.replaceChildren();
    for (const [i, root] of sourceOrder.entries()) {
      const map = maps.find((m) => m.hashtree?.root === root)!;
      if (!map) continue;
      const row = node("div"),
        label = node("label"),
        check = document.createElement("input"),
        up = document.createElement("button");
      row.className = "view-source-row";
      check.type = "checkbox";
      check.checked = selected.has(root);
      check.onchange = () =>
        check.checked ? selected.add(root) : selected.delete(root);
      label.append(check, document.createTextNode(map.manifest.name));
      up.type = "button";
      up.textContent = "↑";
      up.disabled = i === 0;
      up.setAttribute(
        "aria-label",
        `Raise view priority of ${map.manifest.name}`,
      );
      up.onclick = () => {
        [sourceOrder[i - 1], sourceOrder[i]] = [
          sourceOrder[i]!,
          sourceOrder[i - 1]!,
        ];
        drawSources();
      };
      row.append(label, up);
      list.append(row);
    }
    if (!sourceOrder.length)
      list.append(
        node(
          "p",
          "No published maps yet. Publish a library map with Hashtree, then refresh.",
        ),
      );
  }
  function edit(recipe?: ViewRecipe) {
    editing = recipe;
    changed.clear();
    el<HTMLInputElement>("view-name").value =
      recipe?.name ?? "Explore this place";
    selected = new Set(
      recipe?.sources.map((s) => s.root) ?? maps.map((m) => m.hashtree!.root),
    );
    sourceOrder = [
      ...new Set([
        ...(recipe?.sources.map((s) => s.root) ?? []),
        ...maps.map((m) => m.hashtree!.root),
      ]),
    ].filter((root) => maps.some((m) => m.hashtree?.root === root));
    const p = recipe?.presentation ?? defaultPresentation();
    checks("view-layers").forEach(
      (c) => (c.checked = p.layers.includes(c.value as MapLayer)),
    );
    checks("view-tools").forEach(
      (c) => (c.checked = p.tools.includes(c.value as ToolPurpose)),
    );
    const paint = el<HTMLSelectElement>("view-paint");
    paint.querySelector('option[value="custom"]')?.remove();
    const preset = Object.keys(STYLE_PRESETS).find(
      (k) => JSON.stringify(STYLE_PRESETS[k]) === JSON.stringify(p.style),
    );
    if (!preset) paint.add(new Option(`${p.style.name} · custom`, "custom"));
    paint.value = preset ?? "custom";
    if (!recipe) el<HTMLInputElement>("view-default").checked = true;
    el<HTMLInputElement>("view-labels").checked =
      p.labels.places || p.labels.streets || p.labels.pois;
    el<HTMLInputElement>("view-imagery").checked =
      recipe?.sources.some((s) =>
        Object.values(s.rasterLayers ?? {}).some((r) => r.enabled),
      ) ?? false;
    drawSources();
    el<HTMLDetailsElement>("view-editor").open = true;
  }
  async function load() {
    try {
      const r = await fetch("/admin/views");
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      maps = data.maps.filter((m: MapOffer) => m.hashtree);
      const list = el("views-list");
      list.replaceChildren();
      for (const event of data.views) {
        const { recipe } = parseViewAnnouncement(event, data.pubkey);
        const card = node("article"),
          title = node("strong", recipe.name),
          button = document.createElement("button"),
          link = document.createElement("a");
        card.className = "published-view";
        button.type = "button";
        button.textContent = "Edit defaults";
        button.onclick = () => {
          edit(recipe);
          el<HTMLInputElement>("view-default").checked =
            data.defaultView === recipe.id;
        };
        const url = new URL(openClient());
        url.searchParams.set("viewRecipe", event.id);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Open published view ↗";
        card.append(
          title,
          node(
            "small",
            `${data.defaultView === recipe.id ? "Host default · " : ""}${recipe.sources.length} sources · ${recipe.presentation.style.name}`,
          ),
          link,
          button,
        );
        list.append(card);
      }
      if (!list.children.length)
        list.append(
          node(
            "p",
            "No view published. Clients currently choose their own defaults.",
          ),
        );
      if (!editing) {
        sourceOrder = maps.map((m) => m.hashtree!.root);
        selected = new Set(sourceOrder);
        drawSources();
      }
    } catch (e) {
      el("view-status").textContent = String(e);
    }
  }
  el("views-refresh").onclick = () => void load();
  el("view-new").onclick = () => edit();
  el<HTMLFormElement>("view-form").onsubmit = async (e) => {
    e.preventDefault();
    const button =
      el<HTMLFormElement>("view-form").querySelector<HTMLButtonElement>(
        "[type=submit]",
      )!;
    button.disabled = true;
    try {
      const name = el<HTMLInputElement>("view-name").value,
        presentation = editing
          ? structuredClone(editing.presentation)
          : defaultPresentation();
      const paint = el<HTMLSelectElement>("view-paint").value;
      if (!editing || changed.has("view-paint")) {
        if (paint !== "custom") presentation.style = STYLE_PRESETS[paint]!;
      }
      presentation.layers = checks("view-layers")
        .filter((c) => c.checked)
        .map((c) => c.value as MapLayer);
      presentation.tools = checks("view-tools")
        .filter((c) => c.checked)
        .map((c) => c.value as ToolPurpose);
      const labels = el<HTMLInputElement>("view-labels").checked;
      if (!editing || changed.has("view-labels"))
        presentation.labels = { places: labels, streets: labels, pois: labels };
      const recipe = parseViewRecipe({
        version: 1,
        id: editing?.id ?? `view-${crypto.randomUUID()}`,
        name,
        presentation,
        coverage: editing?.coverage ?? false,
        ...(editing?.camera ? { camera: editing.camera } : {}),
        sources: sourceOrder
          .filter((root) => selected.has(root))
          .map((root) => {
            const m = maps.find((m) => m.hashtree?.root === root)!;
            const previous = editing?.sources.find((s) => s.root === root);
            return {
              url: m.url,
              root,
              enabled: previous?.enabled ?? true,
              layers: previous?.layers ?? m.manifest.tileLayers ?? [],
              labels: previous?.labels ?? true,
              rasterLayers: Object.fromEntries(
                (m.manifest.rasters ?? []).map((r) => [
                  r.id,
                  {
                    enabled:
                      previous && !changed.has("view-imagery")
                        ? (previous.rasterLayers?.[r.id]?.enabled ?? false)
                        : el<HTMLInputElement>("view-imagery").checked,
                    opacity: previous?.rasterLayers?.[r.id]?.opacity ?? 0.6,
                  },
                ]),
              ),
            };
          }),
      });
      const r = await fetch("/admin/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe,
          makeDefault: el<HTMLInputElement>("view-default").checked,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      editing = recipe;
      changed.clear();
      await load();
      el("view-status").textContent =
        "View published. New clients can use these defaults; existing shared views stay pinned. No Atlas files were rebuilt.";
    } catch (error) {
      el("view-status").textContent = String(error);
    } finally {
      button.disabled = false;
    }
  };
  await load();
}
