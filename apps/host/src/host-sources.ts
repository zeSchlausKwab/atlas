import { storageSize } from "./host-budget";
import type {
  CachedSource,
  SourceJob,
} from "../../../packages/provisioning/src/source-cache";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`source-${id}`) as T;
async function post(action: string, body: unknown) {
  const r = await fetch(`/admin/sources/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
export async function startSources() {
  let plan: CachedSource | undefined,
    available = 0,
    reserve = 0,
    loading = false,
    action = false;
  function canStart() {
    el<HTMLButtonElement>("start").disabled =
      action || !plan || available < plan.bytes + reserve;
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
        hash.textContent = `Published MD5 verified · SHA-256 ${job.sha256.slice(0, 20)}…`;
        card.append(hash);
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
          .filter((j: SourceJob) => j.state === "ready")
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
        `${plan.name} · ${storageSize(plan.bytes)} (${plan.bytes.toLocaleString()} bytes) · published ${new Date(plan.lastModified).toLocaleDateString()}. ${available < plan.bytes + reserve ? "Not enough free space including the reserve." : "Ready to download; the final file is published only after checksum verification."}`;
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
