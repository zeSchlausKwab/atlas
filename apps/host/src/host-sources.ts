import { storageRequest } from "./host-storage";
import { storageSize } from "./host-budget";
import type {
  CachedSource,
  SourceJob,
} from "../../../packages/provisioning/src/source-cache";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`source-${id}`) as T;
const post = (action: string, body: unknown) =>
  storageRequest(`/admin/sources/${action}`, body);
export async function startSources() {
  let plan: CachedSource | undefined,
    available = 0,
    reserve = 0,
    loading = false,
    action = false;
  function canStart() {
    el<HTMLButtonElement>("start").disabled = action || !plan;
  }
  function render(jobs: SourceJob[]) {
    const list = el("jobs");
    list.replaceChildren();
    for (const job of jobs) {
      const card = document.createElement("article");
      card.className = "preparation-card";
      const h = document.createElement("h3");
      h.textContent = `${job.name} · ${job.state}`;
      const description = document.createElement("p");
      description.textContent = job.error ?? job.message;
      const progress = document.createElement("progress");
      progress.max = job.bytes;
      progress.value = job.completed;
      progress.setAttribute("aria-label", `${job.name} ${job.state}`);
      const size = document.createElement("p");
      size.className = "quiet";
      size.textContent = `${storageSize(job.completed)} / ${storageSize(job.bytes)} · ${((100 * job.completed) / job.bytes).toFixed(1)}%${job.state === "verifying" ? " verified" : ""}`;
      const source = document.createElement("a");
      source.href = job.url;
      source.textContent = "Dated source ↗";
      source.target = "_blank";
      source.rel = "noopener";
      card.append(h);
      if (job.state === "ready") {
        size.textContent = `${storageSize(job.bytes)} · verified PBF · reusable for multiple builds`;
        card.append(size, source);
      } else card.append(description, progress, size, source);
      if (job.state !== "ready") {
        const button = document.createElement("button"),
          paused = ["paused", "failed"].includes(job.state);
        button.textContent = paused
          ? "Resume download"
          : job.state === "waiting"
            ? "Remove from queue"
            : "Pause download";
        button.disabled = action;
        button.onclick = async () => {
          action = true;
          button.disabled = true;
          canStart();
          try {
            await post(paused ? "resume" : "pause", { id: job.id });
          } catch (e) {
            el("plan").textContent = String(e);
          } finally {
            action = false;
            await refresh();
          }
        };
        card.append(button);
      }
      if (job.state === "ready") {
        const prepare = document.createElement("button");
        prepare.textContent = "Use this source";
        prepare.onclick = () =>
          document.dispatchEvent(
            new CustomEvent("atlas-source-prepare", { detail: { id: job.id } }),
          );
        card.append(prepare);
      }
      if (job.sha256) {
        const hash = document.createElement("p");
        hash.className = "quiet";
        hash.textContent = `${job.md5 ? "Published MD5 verified · " : "Retained import · "}SHA-256 ${job.sha256.slice(0, 20)}…`;
        card.append(hash);
      }
      if (["ready", "paused", "failed"].includes(job.state)) {
        const remove = document.createElement("button");
        remove.textContent = "Delete source…";
        remove.onclick = () => {
          const dialog = document.createElement("dialog"),
            title = document.createElement("h3"),
            note = document.createElement("p"),
            confirm = document.createElement("button"),
            cancel = document.createElement("button"),
            error = document.createElement("p");
          dialog.className = "amend-dialog";
          title.textContent = `Delete ${job.name} PBF?`;
          note.textContent =
            "Deletes this cached source and its partial download. Finished Atlas maps remain usable. Future amendments may need to download the pinned PBF again. External NAS files are never deleted.";
          confirm.textContent = "Delete source";
          cancel.textContent = "Keep source";
          error.setAttribute("role", "alert");
          cancel.onclick = () => dialog.close();
          dialog.onclose = () => dialog.remove();
          confirm.onclick = async () => {
            confirm.disabled = true;
            try {
              await post("delete", { id: job.id });
              dialog.close();
              await refresh();
            } catch (e) {
              error.textContent = String(e);
              confirm.disabled = false;
            }
          };
          dialog.append(title, note, error, cancel, confirm);
          document.body.append(dialog);
          dialog.showModal();
        };
        card.append(remove);
      }
      list.append(card);
    }
    if (!jobs.length) list.textContent = "No cached PBF files yet.";
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const r = await fetch("/admin/sources");
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      available = data.storage.availableBytes;
      reserve = data.reserveBytes;
      el("space").textContent =
        `${storageSize(available)} free · source downloads preserve ${storageSize(reserve)} for other work. Compilation requires additional workspace.`;
      render(data.jobs);
      const locations = el<HTMLSelectElement>("location-id"),
        selected = locations.value;
      locations.replaceChildren(
        ...data.jobs
          .filter(
            (j: SourceJob) => j.state === "ready" && j.kind !== "regional",
          )
          .map((j: SourceJob) => new Option(j.name, j.id)),
      );
      if ([...locations.options].some((o) => o.value === selected))
        locations.value = selected;
      if (data.locations?.length)
        el("location-status").textContent = data.locations
          .map(
            (l: any) =>
              `${l.state}: ${l.path} · ${l.bytes ? ((100 * l.completed) / l.bytes).toFixed(1) : 0}% · ${l.message}`,
          )
          .join("\n");
    } catch (e) {
      el("space").textContent = String(e);
    } finally {
      loading = false;
      canStart();
    }
  }
  el("kind").onchange = () => {
    plan = undefined;
    canStart();
    el("plan").textContent = "Check this source before downloading.";
  };
  el("inspect").onclick = async () => {
    const kind = el<HTMLSelectElement>("kind").value;
    el<HTMLButtonElement>("inspect").disabled = true;
    plan = undefined;
    canStart();
    el("plan").textContent =
      "Checking the dated source and published checksum…";
    try {
      const result = (await post("inspect", { kind })) as CachedSource;
      if (kind !== el<HTMLSelectElement>("kind").value) return;
      plan = result;
      el("plan").textContent =
        `${plan.name} · ${storageSize(plan.bytes)} (${plan.bytes.toLocaleString()} bytes) · published ${new Date(plan.lastModified).toLocaleDateString()}. ${available < plan.bytes + reserve ? "This download might exceed available space. You can review the warning and start anyway." : "Ready to download; the final file is published only after checksum verification."}`;
    } catch (e) {
      el("plan").textContent = String(e);
    } finally {
      el<HTMLButtonElement>("inspect").disabled = false;
      canStart();
    }
  };
  el("start").onclick = async () => {
    if (!plan) return;
    action = true;
    canStart();
    try {
      await post("start", { id: plan.id });
      el("plan").textContent =
        "Download started on the server. Progress appears below.";
    } catch (e) {
      el("plan").textContent = String(e);
    } finally {
      action = false;
      await refresh();
    }
  };
  el("location-register").onclick = async () => {
    try {
      const r = await post("location", {
        id: el<HTMLSelectElement>("location-id").value,
        path: el<HTMLInputElement>("location-path").value,
      });
      el("location-status").textContent = r.message;
    } catch (e) {
      el("location-status").textContent = String(e);
    }
  };
  await refresh();
  async function poll() {
    if (!document.hidden) await refresh();
    setTimeout(() => void poll(), 2000);
  }
  void poll();
}
