/** Keep the existing controllers; give related map choices one navigable home. */
export function setupMapWorkbench() {
  const panel = document.getElementById("panel-composer")!;
  const source = panel.querySelector<HTMLElement>(".client-composer")!;
  const data = document.getElementById("panel-data")!,
    appearance = document.getElementById("panel-style")!;
  document.getElementById("tab-style")!.remove();
  document.getElementById("tab-data")!.remove();
  const tab = document.getElementById("tab-composer")!;
  tab.textContent = "Map";
  tab.dataset.tab = "map";
  panel.dataset.panel = "map";
  document.getElementById("open-composer")!.textContent = "Map & layers";
  const header = document.createElement("div");
  header.className = "map-workbench-heading";
  header.innerHTML = `<p class="eyebrow">SOURCES / APPEARANCE / INTENT</p><h2>Your map.</h2>
    <label class="view-picker" for="publisher-view">Published view<select id="publisher-view"><option value="">Your own composition</option></select></label>
    <div class="view-recipe-state"><span id="view-origin" role="status">Client defaults</span><button id="view-reset" disabled>Reset to publisher defaults</button></div>
    <p id="view-contract-note" class="quiet">Appearance changes the picture. Data choices control what this device reads.</p>
    <nav class="map-sections" aria-label="Map settings"><button type="button" data-map-section="sources" aria-pressed="true">Sources</button><button type="button" data-map-section="layers" aria-pressed="false">Layers & data</button><button type="button" data-map-section="appearance" aria-pressed="false">Appearance</button></nav>`;
  source.querySelector(".eyebrow")?.remove();
  source.querySelector("h2")?.remove();
  for (const p of [data, appearance]) {
    p.removeAttribute("role");
    p.removeAttribute("data-panel");
    p.removeAttribute("aria-labelledby");
    p.hidden = true;
  }
  panel.prepend(header);
  panel.append(data, appearance);
  const sections = { sources: source, layers: data, appearance };
  function choose(name: keyof typeof sections) {
    for (const [id, e] of Object.entries(sections)) e.hidden = id !== name;
    header
      .querySelectorAll<HTMLButtonElement>("[data-map-section]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.mapSection === name)),
      );
  }
  header
    .querySelectorAll<HTMLButtonElement>("[data-map-section]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          choose(b.dataset.mapSection as keyof typeof sections)),
    );
  document.addEventListener("atlas-map-section", (event) =>
    choose((event as CustomEvent).detail),
  );
  const saved = document.createElement("button");
  saved.type = "button";
  saved.id = "map-saved-areas";
  saved.className = "map-saved-areas";
  saved.textContent = "Saved areas · inspect in Offline";
  saved.onclick = () =>
    document.querySelector<HTMLButtonElement>('[data-tab="offline"]')!.click();
  data.querySelector(".layers-section")!.append(saved);
  // Display choices never imply semantic feature downloads.
  for (const row of data.querySelectorAll<HTMLElement>(".layer")) {
    const state = document.createElement("small");
    state.className = "layer-load-state";
    row.append(state);
  }
  function refresh() {
    for (const row of data.querySelectorAll<HTMLElement>(".layer")) {
      const input = row.querySelector<HTMLInputElement>("input")!,
        state = row.querySelector(".layer-load-state")!;
      state.textContent = input.disabled
        ? "Not included"
        : input.checked
          ? "Shown · loads in view"
          : "Hidden · no display reads";
    }
    for (const row of data.querySelectorAll<HTMLElement>(".capability")) {
      const input = row.querySelector<HTMLInputElement>("input")!;
      let state = row.querySelector<HTMLElement>(".layer-load-state");
      if (!state) {
        state = document.createElement("small");
        state.className = "layer-load-state";
        row.append(state);
      }
      state.textContent = input.checked
        ? "On demand · when a tool needs it"
        : "Off · no new tool requests";
    }
  }
  data.addEventListener("change", refresh);
  document.addEventListener("atlas-view-change", refresh);
  document.addEventListener("atlas-sources-change", refresh);
  refresh();
}
