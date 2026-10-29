import { storageRequest } from "./host-storage";
import { NO_SIZE_LIMIT } from "../../../packages/provisioning/src/capacity";
import {
  capabilityChoices,
  installedCapabilities,
  pinnedPbfMatches,
} from "../../../packages/provisioning/src/families";
import type { CapabilityChange } from "../../../packages/provisioning/src/compose-capabilities";
import type { PreparationJob } from "../../server/preparations";
import { storageSize } from "./host-budget";
const panels = new Map<string, { snapshot: string; element: HTMLElement }>();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
const post = storageRequest;
/** Keep form nodes across job polling: other builds must not erase uncommitted choices. */
export function capabilityPanel(
  job: PreparationJob,
  sources: { name: string; sha256?: string }[],
  refresh: () => Promise<void>,
) {
  const m = job.manifest!,
    key = m.snapshot + ":" + (job.served !== false);
  const previous = panels.get(job.id);
  if (previous?.snapshot === key) {
    const source = sources.find(
      (s) => s.sha256 && pinnedPbfMatches(m, s.sha256),
    );
    const description = previous.element.querySelector("p.quiet");
    if (description)
      description.textContent = source
        ? `Reusable source: ${source.name} PBF. Missing capabilities are compiled locally when you apply.`
        : "Missing data requires the pinned source; it can be downloaded again if the original dated source is available.";
    return previous.element;
  }
  const panel = el("section"),
    heading = el("h4", "Capabilities to serve"),
    description = el("p");
  panel.className = "capability-composer";
  panel.setAttribute("aria-label", `Capabilities for ${job.name}`);
  const source = sources.find((s) => s.sha256 && pinnedPbfMatches(m, s.sha256));
  description.className = "quiet";
  description.textContent = source
    ? `Reusable source: ${source.name} PBF. Missing capabilities are compiled locally when you apply.`
    : job.sourcePlan
      ? "The pinned PBF can be downloaded again if needed. Existing Atlas sources can also supply capabilities."
      : "Existing Atlas sources can supply matching capabilities. Missing data requires the original PBF snapshot.";
  panel.append(heading, description);
  const installed = installedCapabilities(m),
    checks = new Map<string, HTMLInputElement>();
  for (const group of ["Map", "Navigation", "Analysis"]) {
    const field = el("fieldset"),
      legend = el("legend", group);
    field.append(legend);
    for (const choice of capabilityChoices(m).filter(
      (c) => c.group === group,
    )) {
      const label = el("label"),
        input = el("input"),
        state = el(
          "small",
          installed.includes(choice.id) ? "In file" : "Build when applied",
        );
      label.className = "capability-option";
      input.type = "checkbox";
      input.checked = installed.includes(choice.id);
      input.value = choice.id;
      label.append(input, el("span", choice.label), state);
      field.append(label);
      checks.set(choice.id, input);
    }
    panel.append(field);
  }
  const status = el("p"),
    actions = el("div"),
    review = el("button", "Review changes"),
    apply = el("button", "Apply & queue");
  status.setAttribute("role", "status");
  actions.className = "host-actions";
  review.type = apply.type = "button";
  actions.append(review, apply);
  panel.append(actions, status);
  let busy = false,
    version = 0;
  const selected = () =>
    [...checks].filter(([, c]) => c.checked).map(([id]) => id);
  const sync = () => {
    const chosen = selected(),
      changed =
        chosen.length !== installed.length ||
        chosen.some((c) => !installed.includes(c));
    review.disabled = apply.disabled = busy || !changed || !chosen.length;
  };
  const reset = () => {
    version++;
    status.textContent = "";
    sync();
  };
  for (const c of checks.values()) c.onchange = reset;
  const request = (): CapabilityChange => ({
    targetId: job.id,
    targetSnapshot: m.snapshot,
    name: job.name,
    capabilities: selected(),
    paddingCells: m.selection?.routingPaddingCells ?? 1,
    maxBytes: NO_SIZE_LIMIT,
  });
  async function run(commit: boolean) {
    const current = ++version;
    busy = true;
    sync();
    status.textContent = "Checking retained data and source dependencies…";
    try {
      const plan = await post(
        "/admin/preparations/capabilities-plan",
        request(),
      );
      if (current !== version) return;
      status.textContent = `Reuse existing data · add ${plan.additions.length} · remove ${plan.removals.length} · source: ${plan.sourceName}. Approximate workspace: ${storageSize(plan.estimatedWorkspaceBytes)} including free-space reserve. ${plan.warnings.join(" ")}`;
      if (commit) {
        // Freeze the reviewed selection while committing; queued build pins both inputs.
        for (const c of checks.values()) c.disabled = true;
        const result = await post(
          "/admin/preparations/capabilities",
          plan.change,
        );
        status.textContent =
          "Queued. Progress is in Builds & checkpoints. This revision stays served until the new file succeeds.";
        panels.delete(job.id);
        await refresh();
        document
          .getElementById("prepare-jobs")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (e) {
      status.textContent = String(e);
    } finally {
      busy = false;
      for (const c of checks.values()) c.disabled = false;
      sync();
    }
  }
  review.onclick = () => void run(false);
  apply.onclick = () => void run(true);
  sync();
  panels.set(job.id, { snapshot: key, element: panel });
  return panel;
}
