import { startDiscovery } from "./host-discovery";
import { startSources } from "./host-sources";
import { openClient } from "./client-link";
import { startBuilder } from "./host-builder";
import type { CatalogEntry } from "../../../packages/operations/src/registry";
const el = (id: string) => document.getElementById(`host-${id}`)!;
async function load() {
  try {
    const response = await fetch("/admin/operations");
    if (!response.ok) throw new Error(await response.text());
    render(await response.json());
    const health = await (await fetch("/health")).json();
    el("cvm").textContent = health.contextvm
      ? "Connected · private tools over Nostr"
      : "Not connected · configure ATLAS_CVM_* to enable";
    el("package").textContent = health.name ?? "Current atlas";
  } catch (e) {
    el("status").textContent = String(e);
  }
}
function render(catalog: any) {
  el("status").textContent =
    `${catalog.plugins.filter((p: CatalogEntry) => p.enabled && p.available).length} operations enabled. Changes apply to HTTP and ContextVM immediately.`;
  el("coverage").textContent =
    `Snapshot ${catalog.snapshot.slice(0, 16)}… · ${catalog.coverage.completeness}`;
  const list = el("tools");
  list.replaceChildren();
  for (const d of catalog.plugins as CatalogEntry[]) {
    const row = document.createElement("article");
    row.className = "host-tool";
    const content = document.createElement("div"),
      title = document.createElement("h3"),
      description = document.createElement("p"),
      identity = document.createElement("p"),
      data = document.createElement("p");
    title.textContent = d.title;
    description.textContent = d.description;
    identity.className = "plugin-identity";
    identity.textContent = `${d.id} · v${d.version} · ${d.implementation.slice(0, 16)}`;
    data.className = "quiet";
    data.textContent = `${d.available ? "Data available" : "Required data missing"} · ${d.requirements.map((r) => r.family).join(", ") || d.purposes.join(", ") || "package"} · ${d.result === "file" ? "HTTP file download" : "HTTP + ContextVM"}`;
    const details = document.createElement("details"),
      summary = document.createElement("summary"),
      pre = document.createElement("pre");
    summary.textContent = "Contract & data requirements";
    pre.textContent = JSON.stringify(d, null, 2);
    details.append(summary, pre);
    content.append(title, description, data, identity, details);
    const label = document.createElement("label"),
      input = document.createElement("input"),
      text = document.createElement("span");
    label.className = "host-switch";
    input.type = "checkbox";
    input.checked = d.enabled;
    input.setAttribute("aria-label", `Enable ${d.title}`);
    text.textContent = d.enabled ? "Enabled" : "Disabled";
    input.onchange = async () => {
      input.disabled = true;
      try {
        const response = await fetch("/admin/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: d.id,
            implementation: d.implementation,
            enabled: input.checked,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        render(await response.json());
      } catch (e) {
        input.checked = d.enabled;
        input.disabled = false;
        el("status").textContent = `Change not saved: ${String(e)}`;
      }
    };
    label.append(input, text);
    row.append(content, label);
    list.append(row);
  }
}
el("refresh").onclick = () => void load();
(document.getElementById("open-client") as HTMLAnchorElement).href =
  openClient();
async function start() {
  try {
    const response = await fetch("/host-config.json");
    if (!response.ok)
      throw new Error(`Host configuration: HTTP ${response.status}`);
    const config = await response.json();
    el("access").textContent = config.administration.allowed
      ? `${config.administration.mode} · ${location.host}`
      : config.administration.message;
    if (!config.administration.allowed)
      throw new Error(config.administration.message);
    await Promise.all([
      load(),
      startBuilder(),
      startSources(),
      startDiscovery(),
    ]);
  } catch (error) {
    el("access").textContent = String(error);
    for (const id of [
      "host-package",
      "host-cvm",
      "host-status",
      "prepare-source",
      "prepare-storage-free",
      "prepare-message",
    ])
      document.getElementById(id)!.textContent =
        "Administration unavailable. See the access message above.";
    for (const input of document.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >(
      "#prepare input, #prepare select, #prepare button, #sources button, #sources select, #host-refresh",
    ))
      input.disabled = true;
  }
}
void start();
