import { showHostSection } from "./host-workbench";
import type { Manifest } from "../../../packages/format/src/index";
import type {
  RasterAmendment,
  RasterAmendmentPlan,
  RasterChoice,
} from "../../../packages/provisioning/src/raster-amend";
import { NO_SIZE_LIMIT } from "../../../packages/provisioning/src/capacity";
import type { PreparationJob } from "../../server/preparations";
import { storageRequest } from "./host-storage";
import { storageSize } from "./host-budget";
type Source = { id: string; manifest: Manifest };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
/** Dialog lives outside the polled library, retaining the user's reviewed choices. */
export function openRasterAmendment(
  target: PreparationJob,
  sources: Source[],
  refresh: () => Promise<void>,
) {
  if (!target.manifest || document.getElementById("raster-amend-dialog"))
    return;
  const manifest = target.manifest,
    dialog = el("dialog"),
    form = el("form"),
    title = el("h2", `Imagery in ${target.name}`);
  dialog.id = "raster-amend-dialog";
  dialog.className = "amend-dialog";
  title.id = "raster-amend-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const revision = el("input");
  revision.value = target.name;
  revision.maxLength = 80;
  revision.required = true;
  const revisionLabel = el("label", "Revision name");
  revisionLabel.append(revision);
  const choices = el("div"),
    status = el("div"),
    actions = el("div");
  status.setAttribute("role", "status");
  actions.className = "host-actions";
  const add = el("button", "Add imagery layer"),
    review = el("button", "Review imagery changes"),
    apply = el("button", "Queue imagery amendment"),
    close = el("button", "Close");
  for (const b of [add, review, apply, close]) b.type = "button";
  const upload = el("a", "Upload another image ↗");
  upload.href = "#imagery";
  upload.onclick = () => dialog.close();
  const candidates = sources.flatMap((source) =>
    (source.manifest.rasters ?? []).map((layer) => ({
      source,
      layer,
      value: `${source.id}/${layer.id}`,
    })),
  );
  const rows: Array<{
    id: string;
    keep: HTMLInputElement;
    name: HTMLInputElement;
    source: HTMLSelectElement;
  }> = [];
  let version = 0,
    busy = false,
    approved: RasterAmendment | undefined;
  const invalidate = () => {
    version++;
    approved = undefined;
    apply.disabled = true;
    status.replaceChildren();
  };
  const insert = (id: string, name: string, existing: boolean) => {
    const field = el("fieldset"),
      keep = el("input"),
      label = el("label"),
      input = el("input"),
      source = el("select"),
      note = el("p");
    field.className = "raster-amend-row";
    field.append(
      el("legend", existing ? "Installed imagery" : "Additional imagery"),
    );
    label.className = "amend-profile";
    keep.type = "checkbox";
    keep.checked = true;
    label.append(keep, document.createTextNode(`Include ${name}`));
    input.value = name;
    input.maxLength = 80;
    input.required = true;
    const nameLabel = el("label", "Layer name");
    nameLabel.append(input);
    if (existing) source.append(new Option("Keep existing pixels", ""));
    for (const c of candidates)
      source.append(
        new Option(`${c.source.manifest.name} · ${c.layer.name}`, c.value),
      );
    const sourceLabel = el(
      "label",
      existing ? "Pixels · choose another source to replace" : "Pixels from",
    );
    sourceLabel.append(source);
    const describe = () => {
      const c = candidates.find((c) => c.value === source.value),
        r = c?.layer ?? manifest.rasters?.find((r) => r.id === id);
      note.textContent = r
        ? `${r.source.attribution} · ${r.source.license} · z${r.minZoom}–${r.maxZoom}. ${source.value && existing ? "Replaces this layer in the new revision." : "Pixels are copied without recompression."}`
        : "No image source available.";
    };
    note.className = "quiet";
    source.onchange = () => {
      describe();
      invalidate();
    };
    keep.onchange = () => {
      input.disabled = source.disabled = !keep.checked;
      invalidate();
    };
    input.oninput = invalidate;
    field.append(label, nameLabel, sourceLabel, note);
    choices.append(field);
    rows.push({ id, keep, name: input, source });
    describe();
    invalidate();
  };
  for (const r of manifest.rasters ?? []) insert(r.id, r.name, true);
  add.disabled = !candidates.length;
  add.onclick = () => {
    const c = candidates[0];
    if (c)
      insert(`image-${crypto.randomUUID().slice(0, 8)}`, c.layer.name, false);
  };
  if (!candidates.length)
    choices.append(
      el(
        "p",
        "Upload imagery first, then return here to include it in this map.",
      ),
    );
  const request = (): RasterAmendment => ({
    targetId: target.id,
    targetSnapshot: manifest.snapshot,
    name: revision.value,
    maxBytes: NO_SIZE_LIMIT,
    layers: rows
      .filter((r) => r.keep.checked)
      .map((r) => {
        const c = candidates.find((c) => c.value === r.source.value);
        return {
          id: r.id,
          name: r.name.value,
          ...(c
            ? {
                sourceId: c.source.id,
                sourceSnapshot: c.source.manifest.snapshot,
                sourceLayer: c.layer.id,
              }
            : {}),
        } satisfies RasterChoice;
      }),
  });
  const freeze = (value: boolean) => {
    busy = value;
    for (const input of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("input,select"))
      input.disabled = value;
    if (!value)
      for (const row of rows)
        row.name.disabled = row.source.disabled = !row.keep.checked;
    add.disabled = value || !candidates.length;
    review.disabled = value;
    apply.disabled = value || !approved;
  };
  revision.oninput = invalidate;
  review.onclick = async () => {
    if (busy || !form.reportValidity()) return;
    invalidate();
    const generation = version;
    freeze(true);
    status.textContent = "Checking layer coverage and reusable data…";
    try {
      const p: RasterAmendmentPlan = await storageRequest(
        "/admin/preparations/raster-plan",
        request(),
      );
      if (generation !== version || !dialog.open) return;
      approved = p.request;
      const list = el("ul");
      for (const line of [
        `Reuse ${p.reuse.blocks.toLocaleString()} blocks · ${storageSize(p.reuse.bytes)}.`,
        `Import ${p.addition.blocks.toLocaleString()} tiles · ${storageSize(p.addition.bytes)}.`,
        ...(p.replaced.length ? [`Replace: ${p.replaced.join(", ")}.`] : []),
        ...(p.removed.length ? [`Remove: ${p.removed.join(", ")}.`] : []),
        `New file approximately ${storageSize(p.estimatedOutputBytes)}; workspace allowance ${storageSize(p.estimatedWorkspaceBytes)} including reserve.`,
      ])
        list.append(el("li", line));
      const details = el("details");
      details.append(el("summary", "Coverage, copying and publication"));
      p.warnings.forEach((w) => details.append(el("p", w)));
      status.replaceChildren(list, details);
    } catch (e) {
      status.textContent = String(e);
    } finally {
      freeze(false);
    }
  };
  apply.onclick = async () => {
    if (!approved || busy) return;
    const input = approved;
    freeze(true);
    try {
      await storageRequest("/admin/preparations/raster", input);
      approved = undefined;
      status.textContent =
        "Queued. This revision stays served until its replacement succeeds.";
      await refresh();
      dialog.close();
      showHostSection("builds");
    } catch (e) {
      status.textContent = String(e);
    } finally {
      freeze(false);
    }
  };
  close.onclick = () => dialog.close();
  dialog.onclose = () => {
    version++;
    dialog.remove();
  };
  form.onsubmit = (e) => e.preventDefault();
  actions.append(add, review, apply, close);
  form.append(
    title,
    el(
      "p",
      "Add, replace or remove raster layers in a new self-contained revision. Geometry, routing, search and custom data remain unchanged.",
    ),
    revisionLabel,
    choices,
    upload,
    actions,
    status,
  );
  dialog.append(form);
  document.body.append(dialog);
  apply.disabled = true;
  dialog.showModal();
}
