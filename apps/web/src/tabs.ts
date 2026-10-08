export function activateTab(name: string, focus = false) {
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
  activateTab("explore");
}
