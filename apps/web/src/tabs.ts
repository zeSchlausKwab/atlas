export function activateTab(name: string, focus = false) {
  const section =
    name === "style"
      ? "appearance"
      : name === "data"
        ? "layers"
        : name === "composer"
          ? "sources"
          : undefined;
  if (section) name = "map";
  document.body.dataset.tab = name;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(
    '[role="tab"]',
  )) {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const panel of document.querySelectorAll<HTMLElement>(
    '[role="tabpanel"]',
  ))
    panel.hidden = panel.dataset.panel !== name;
  if (section)
    document.dispatchEvent(
      new CustomEvent("atlas-map-section", { detail: section }),
    );
  document.dispatchEvent(new Event("atlas-tab"));
}
export function setupTabs() {
  const tabs = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  tabs.forEach((t, i) => {
    t.onclick = () => activateTab(t.dataset.tab!);
    t.onkeydown = (e) => {
      let n = i;
      if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") n = (i + tabs.length - 1) % tabs.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = tabs.length - 1;
      else return;
      e.preventDefault();
      activateTab(tabs[n]!.dataset.tab!, true);
    };
  });
  window.addEventListener("hashchange", (event) => {
    const oldHash = new URLSearchParams(new URL(event.oldURL).hash.slice(1));
    const newHash = new URLSearchParams(new URL(event.newURL).hash.slice(1));
    // replaceState saves editor changes without firing this event. Browser navigation
    // to another recipe must recreate its readers and tools.
    if (oldHash.get("view") !== newHash.get("view")) {
      location.reload();
      return;
    }
    const name = newHash.get("tab");
    if (
      name &&
      (["composer", "style", "data"].includes(name) ||
        tabs.some((t) => t.dataset.tab === name))
    )
      activateTab(name!);
  });
  const initial = new URLSearchParams(location.hash.slice(1)).get("tab");
  activateTab(
    initial &&
      (["composer", "style", "data"].includes(initial) ||
        tabs.some((t) => t.dataset.tab === initial))
      ? initial
      : "map",
  );
  document
    .getElementById("open-composer")
    ?.addEventListener("click", () => activateTab("composer"));
}
