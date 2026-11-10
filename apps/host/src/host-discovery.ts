import { hostActivity, showHostSection } from "./host-workbench";
export async function publishMap(id: string) {
  const status = document.getElementById("discovery-status")!;
  status.textContent = "Starting Hashtree publication…";
  try {
    const r = await fetch("/admin/discovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    status.textContent = "Indexing started. Progress appears below.";
    showHostSection("discovery");
  } catch (e) {
    status.textContent = String(e);
  }
}
export async function startDiscovery() {
  const identity = await (await fetch("/discovery")).json();
  document.getElementById("discovery-identity")!.textContent =
    `Relay: ${identity.relay} · Publisher: ${identity.pubkey}`;
  document.getElementById("discovery-base")!.onclick = () =>
    void publishMap("demo");
  async function poll() {
    try {
      if (!document.hidden) {
        const response = await fetch("/admin/discovery"),
          data = await response.json();
        if (!response.ok) throw new Error(data.error);
        hostActivity(
          "Publication",
          "discovery",
          data.jobs.map((j: any) => ({
            id: j.id,
            name: j.offer?.manifest.name ?? j.id,
            state: j.state,
            message: j.message,
            completed: j.completed,
            total: j.bytes,
          })),
        );
        const list = document.getElementById("discovery-jobs")!;
        list.replaceChildren();
        for (const job of data.jobs) {
          const card = document.createElement("article");
          card.className = "preparation-card";
          const title = document.createElement("h3");
          title.textContent = `${job.offer?.manifest.name ?? job.id} · ${job.state}`;
          const p = document.createElement("p");
          p.textContent = job.message;
          const progress = document.createElement("progress");
          progress.max = job.bytes;
          progress.value = job.completed;
          progress.setAttribute("aria-label", "Hashtree indexing progress");
          card.append(title, p, progress);
          if (job.offer) {
            const info = document.createElement("p");
            info.className = "quiet";
            info.textContent = `Root ${job.offer.hashtree.root} · ${(job.offer.hashtree.chunkBytes / 1024).toFixed(0)} KiB blocks`;
            card.append(info);
          }
          list.append(card);
        }
      }
    } catch (e) {
      document.getElementById("discovery-status")!.textContent = String(e);
    }
    setTimeout(() => void poll(), 2000);
  }
  void poll();
}
