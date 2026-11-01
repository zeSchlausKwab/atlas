import { cartography, workbenchIcon } from "./host-cartography";
/** Navigation and activity are independent of the long-running host controllers. */
type Activity = {
  id: string;
  name: string;
  state: string;
  message?: string;
  completed?: number;
  total?: number;
};
const groups = new Map<string, { target: string; items: Activity[] }>();
const busy = new Set([
  "running",
  "cancelling",
  "planning",
  "fetching",
  "packing",
  "downloading",
  "verifying",
  "indexing",
  "uploading",
  "publishing",
]);
const attention = new Set(["failed", "paused", "review"]);
let paint = () => {};
export function hostActivity(group: string, target: string, items: Activity[]) {
  groups.set(group, { target, items });
  paint();
}
export function showHostSection(id: string) {
  if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
export function startWorkbench() {
  const main = document.querySelector<HTMLElement>(".host-workspace")!;
  main.classList.add("host-workbench");
  main.querySelector(".host-heading")!.remove();
  main.querySelector(".host-section-nav")!.remove();
  const tabs = [
    {
      id: "library",
      title: "Library",
      heading: "Your maps, ready to serve.",
      note: "Choose what you share. Combine maps, amend capabilities and publish a verified Hashtree revision.",
      sections: ["library"],
    },
    {
      id: "prepare",
      title: "Prepare",
      heading: "Make a map of your own.",
      note: "Start with a source, draw an area and choose its capabilities. The server keeps working when you leave this page.",
      sections: ["prepare", "sources"],
    },
    {
      id: "imports",
      title: "Import",
      heading: "Bring your own view.",
      note: "Import an Atlas file or raster tiles, or place an image on Earth. Everything joins the same map library.",
      sections: ["imports", "imagery"],
    },
    {
      id: "federation",
      title: "Network",
      heading: "Find the missing pieces.",
      note: "Connect trusted publishers, inspect coverage and acquire only the data your area needs.",
      sections: ["federation", "discovery"],
    },
    {
      id: "storage",
      title: "Storage",
      heading: "Room to build.",
      note: "Keep maps close. Give preparation a little more room on another disk or your NAS.",
      sections: ["storage"],
    },
    {
      id: "operations",
      title: "Tools",
      heading: "Give your maps abilities.",
      note: "Choose the operations this host offers over HTTP and ContextVM. Each tool explains the data it needs.",
      sections: ["operations"],
    },
  ];
  const nav = document.createElement("nav");
  nav.className = "workbench-tabs";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Host workspace");
  const body = document.createElement("div");
  body.className = "workbench-body";
  const content = document.createElement("div");
  content.className = "workbench-content";
  const rail = document.createElement("aside");
  rail.className = "workbench-activity";
  rail.id = "host-activity";
  rail.setAttribute("aria-label", "Downloads and preparations");
  rail.innerHTML = `<button class="activity-toggle" aria-expanded="false" aria-controls="activity-body"><span>Activity</span><span id="activity-count">Connecting…</span></button><div id="activity-body"><p class="activity-caption">Downloads · preparations · publication<br>Server work continues across tabs.</p><div id="activity-live" role="status"></div><div id="activity-feed"></div><details class="activity-builds" open><summary>Builds & checkpoints</summary></details></div>`;
  const builds = rail.querySelector(".activity-builds")!;
  builds.append(
    document.getElementById("builds")!,
    document.getElementById("prepare-jobs")!,
  );
  const panels = tabs.map((tab) => {
    const button = document.createElement("button");
    button.id = `host-tab-${tab.id}`;
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `host-panel-${tab.id}`);
    const symbol = document.createElement("span");
    symbol.className = "workbench-tab-icon";
    symbol.setAttribute("aria-hidden", "true");
    symbol.innerHTML = workbenchIcon(tab.id);
    button.append(symbol, document.createTextNode(tab.title));
    button.onclick = () => showHostSection(tab.id);
    nav.append(button);
    const panel = document.createElement("section");
    panel.id = `host-panel-${tab.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panel.tabIndex = 0;
    const header = document.createElement("header");
    header.className = "workbench-intro";
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = `HOST WORKBENCH / ${tab.title.toUpperCase()}`;
    const h = document.createElement("h1");
    h.textContent = tab.heading;
    const p = document.createElement("p");
    p.textContent = tab.note;
    header.append(eyebrow, h, p);
    header.insertAdjacentHTML("beforeend", cartography);
    panel.append(header);
    if (
      tab.id === "prepare" ||
      tab.id === "imports" ||
      tab.id === "federation"
    ) {
      const links = document.createElement("nav");
      links.className = "workbench-shortcuts";
      links.setAttribute("aria-label", `${tab.title} sections`);
      const names: Record<string, string> = {
        prepare: "Build a map",
        sources: "Source files & downloads",
        imports: "Atlas / MBTiles",
        imagery: "Place an image",
        federation: "Coverage & acquisition",
        discovery: "Publish & announce",
      };
      for (const id of tab.sections) {
        const a = document.createElement("a");
        a.href = `#${id}`;
        a.textContent = names[id]!;
        links.append(a);
      }
      panel.append(links);
    }
    for (const id of tab.sections) panel.append(document.getElementById(id)!);
    content.append(panel);
    return { tab, button, panel };
  });
  const access = document.getElementById("host-access")!;
  main.append(nav, access, body);
  body.append(content, rail);
  const toggle = rail.querySelector<HTMLButtonElement>(".activity-toggle")!;
  const compact = window.matchMedia("(max-width:1000px)");
  const activityAria = () => {
    toggle.tabIndex = compact.matches ? 0 : -1;
    toggle.setAttribute(
      "aria-expanded",
      String(!compact.matches || rail.classList.contains("expanded")),
    );
  };
  compact.addEventListener("change", activityAria);
  activityAria();
  toggle.onclick = () => {
    const open = !rail.classList.contains("expanded");
    rail.classList.toggle("expanded", open);
    activityAria();
  };
  const activate = (initial = false) => {
    const id =
      location.hash.slice(1) ||
      (new URL(location.href).searchParams.has("area") ? "prepare" : "library");
    const target = document.getElementById(id);
    const found =
      panels.find(({ panel }) => target && panel.contains(target)) ??
      panels.find((p) => p.tab.id === id) ??
      panels[0]!;
    for (const { panel, button } of panels) {
      const selected = panel === found.panel;
      panel.hidden = !selected;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (target instanceof HTMLDetailsElement) target.open = true;
    if (id === "builds" || id === "prepare-jobs") {
      rail.classList.add("expanded");
      toggle.setAttribute("aria-expanded", "true");
    }
    // Preview implementations observe resize; switching from display:none needs a fresh frame.
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      if (!initial && target)
        (id === found.tab.id ? found.panel : target).scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
    });
  };
  nav.onkeydown = (e) => {
    const buttons = panels.map((p) => p.button),
      current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : e.key === "ArrowRight"
            ? (current + 1) % buttons.length
            : e.key === "ArrowLeft"
              ? (current + buttons.length - 1) % buttons.length
              : -1;
    if (index >= 0) {
      e.preventDefault();
      buttons[index]!.focus();
      buttons[index]!.click();
    }
  };
  window.addEventListener("hashchange", () => activate());
  activate(true);
  let key = "";
  paint = () => {
    const records = [...groups].flatMap(([group, value]) =>
      value.items.map((item) => ({ ...item, group, target: value.target })),
    );
    const running = records.filter((r) => busy.has(r.state)).length,
      queued = records.filter((r) =>
        ["queued", "waiting"].includes(r.state),
      ).length,
      needs = records.filter((r) => attention.has(r.state)).length;
    const text = `${running} active · ${queued} queued${needs ? ` · ${needs} need attention` : ""}`;
    document.getElementById("activity-count")!.textContent = text;
    document.getElementById("activity-live")!.textContent = text;
    const items = records.filter(
      (r) =>
        r.group !== "Build" &&
        !["ready", "cancelled", "retained", "complete", "published"].includes(
          r.state,
        ),
    );
    const next = JSON.stringify(items);
    if (next === key) return;
    key = next;
    const feed = document.getElementById("activity-feed")!;
    feed.replaceChildren();
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "activity-card";
      card.dataset.state = item.state;
      const kind = document.createElement("small");
      kind.textContent = `${item.group} · ${item.state}`;
      const name = document.createElement("strong");
      name.textContent = item.name;
      const message = document.createElement("p");
      message.textContent = item.message ?? "";
      const link = document.createElement("a");
      link.href = `#${item.target}`;
      link.textContent = "Details & controls →";
      card.append(kind, name, message);
      if (item.total) {
        const meter = document.createElement("progress");
        meter.max = item.total;
        meter.value = item.completed ?? 0;
        meter.setAttribute("aria-label", `${item.name} progress`);
        card.append(meter);
      }
      card.append(link);
      feed.append(card);
    }
  };
  paint();
}
