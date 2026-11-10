import type {
  Manifest,
  TransportMode,
} from "../../../packages/format/src/index";
import type { AmendmentPlan } from "../../../packages/provisioning/src/amend";
import type {
  HostedAmendment,
  PreparationJob,
} from "../../server/preparations";
import { storageSize } from "./host-budget";
type Source = { id: string; manifest: Manifest; bytes: number };
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Amendment request failed");
  return data;
}
/** Kept outside the polled library DOM so a running build cannot reset form edits. */
export function openAmendment(
  target: PreparationJob,
  sources: Source[],
  refresh: () => Promise<void>,
) {
  if (!target.manifest || document.getElementById("map-amend-dialog")) return;
  const m = target.manifest,
    dialog = element("dialog"),
    form = element("form");
  dialog.id = "map-amend-dialog";
  dialog.className = "amend-dialog";
  dialog.setAttribute("aria-labelledby", "map-amend-title");
  const title = element("h2", `Amend ${target.name}`);
  title.id = "map-amend-title";
  form.append(
    title,
    element(
      "p",
      "Add routing to a new revision. Existing geometry, labels, search, features and custom blocks are reused unchanged.",
    ),
  );
  const source = element("select"),
    name = element("input"),
    budget = element("input"),
    padding = element("select");
  name.value = `${target.name.slice(0, 65)} · routing`;
  name.maxLength = 80;
  name.required = true;
  budget.type = "number";
  budget.min = "1";
  budget.step = "1";
  budget.required = true;
  for (let n = 0; n <= 4; n++) padding.append(new Option(String(n), String(n)));
  padding.value = String(m.selection?.routingPaddingCells ?? 1);
  const label = (text: string, input: HTMLElement) => {
    const l = element("label", text);
    l.append(input);
    return l;
  };
  const candidates = sources.filter(
    (s) =>
      s.id !== target.id &&
      s.manifest.source.sha256 === m.source.sha256 &&
      s.manifest.transport,
  );
  for (const s of candidates) source.append(new Option(s.manifest.name, s.id));
  if (!candidates.length)
    source.append(new Option("No compatible routing source installed", ""));
  form.append(
    label("New revision name", name),
    label("Routing source · same source snapshot", source),
  );
  const choices = element("fieldset");
  choices.append(element("legend", "Routing & isochrones"));
  const checks = new Map<TransportMode, HTMLInputElement>();
  for (const mode of ["walking", "cycling", "driving"] as const) {
    const input = element("input");
    input.type = "checkbox";
    input.value = mode;
    checks.set(mode, input);
    const l = element("label");
    l.className = "amend-profile";
    l.append(
      input,
      document.createTextNode(
        mode[0].toUpperCase() +
          mode.slice(1) +
          (m.transport?.profiles[mode] ? " · already included" : ""),
      ),
    );
    choices.append(l);
  }
  form.append(
    choices,
    label("Routing padding (cells)", padding),
    label("Maximum new file size (MiB)", budget),
  );
  const note = element(
    "p",
    "This first amendment supports existing Atlas routing cells. If no compatible source is available, routing must first be built from the pinned source PBF. Raster imports and other amendments are planned next.",
  );
  note.className = "quiet";
  form.append(note);
  const status = element("div");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = element("div");
  actions.className = "host-actions";
  const review = element("button", "Review amendment"),
    start = element("button", "Queue amended revision"),
    cancel = element("button", "Close");
  for (const b of [review, start, cancel]) b.type = "button";
  start.disabled = true;
  actions.append(review, start, cancel);
  form.append(status, actions);
  dialog.append(form);
  let generation = 0,
    approved: HostedAmendment | undefined;
  const invalidate = () => {
    generation++;
    approved = undefined;
    start.disabled = true;
    status.replaceChildren();
  };
  const updateSource = () => {
    invalidate();
    const s = candidates.find((s) => s.id === source.value);
    budget.value = String(
      Math.ceil(((target.size ?? 0) + (s?.bytes ?? 0) + 1024 ** 2) / 1024 ** 2),
    );
    for (const [mode, input] of checks) {
      input.disabled =
        !!m.transport?.profiles[mode] || !s?.manifest.transport?.profiles[mode];
      input.checked = !input.disabled;
    }
    review.disabled = !s || [...checks.values()].every((c) => c.disabled);
    if (review.disabled)
      status.textContent = s
        ? "This map already has all the routing modes available in that source."
        : "Install a compatible Atlas source with routing to amend this map.";
  };
  source.onchange = updateSource;
  for (const input of [name, budget, padding, ...checks.values()])
    input.addEventListener("input", invalidate);
  const request = (): HostedAmendment => ({
    targetId: target.id,
    sourceId: source.value,
    targetSnapshot: m.snapshot,
    sourceSnapshot: candidates.find((s) => s.id === source.value)!.manifest
      .snapshot,
    name: name.value,
    maxBytes: Number(budget.value) * 1024 ** 2,
    paddingCells: Number(padding.value),
    profiles: [...checks]
      .filter(([, c]) => c.checked && !c.disabled)
      .map(([mode]) => mode),
  });
  review.onclick = async () => {
    if (!form.reportValidity()) return;
    invalidate();
    const current = generation;
    review.disabled = true;
    status.textContent = "Checking compatibility and selected routing cells…";
    try {
      const input = request(),
        plan: AmendmentPlan = await post(
          "/admin/preparations/amend-plan",
          input,
        );
      if (current !== generation || !dialog.open) return;
      const list = element("ul");
      for (const line of [
        `Reuse ${plan.reuse.blocks.toLocaleString()} blocks · ${storageSize(plan.reuse.bytes)} unchanged payload.`,
        `Add ${plan.addition.blocks.toLocaleString()} routing cells · ${storageSize(plan.addition.bytes)}.`,
        `Estimated new file: ${storageSize(plan.estimatedOutputBytes)}.`,
        `Estimated free space needed: ${storageSize(plan.estimatedWorkspaceBytes)}, including the server reserve. The original file stays on disk.`,
      ])
        list.append(element("li", line));
      const details = element("details");
      details.append(element("summary", "Coverage, copying and publication"));
      for (const warning of plan.warnings)
        details.append(element("p", warning));
      status.replaceChildren(list, details);
      approved = input;
      start.disabled = false;
    } catch (e) {
      if (current === generation) status.textContent = String(e);
    } finally {
      review.disabled = false;
    }
  };
  start.onclick = async () => {
    if (!approved) return;
    const input = approved;
    approved = undefined;
    start.disabled = true;
    review.disabled = true;
    // Freeze the reviewed request while the queue accepts it.
    for (const input of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("input, select"))
      input.disabled = true;
    try {
      const job: PreparationJob = await post(
        "/admin/preparations/amend",
        input,
      );
      status.textContent = `Queued ${job.name}. Follow it in Builds & checkpoints. Publish with Hashtree when the new revision is ready.`;
      await refresh();
    } catch (e) {
      status.textContent = String(e);
      for (const input of [name, budget, padding, source])
        input.disabled = false;
      updateSource();
      status.textContent = String(e);
    }
  };
  form.onsubmit = (e) => e.preventDefault();
  cancel.onclick = () => dialog.close();
  dialog.onclose = () => {
    generation++;
    dialog.remove();
  };
  document.body.append(dialog);
  updateSource();
  dialog.showModal();
}
