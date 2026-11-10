import type { PublicFipsStatus } from "../../../experiments/fips-preview/public-status";

const STALE_MS = 30_000;
export function fipsStatusView(
  status: PublicFipsStatus | undefined,
  now = Date.now(),
) {
  if (!status) return { state: "unavailable", title: "Status unavailable" };
  if (status.state === "stopped")
    return { state: "stopped", title: "Provider stopped" };
  if (now - Date.parse(status.updatedAt) > STALE_MS)
    return { state: "stale", title: "Status is stale" };
  return status.state === "connected"
    ? { state: "connected", title: "Connected to the FIPS network" }
    : { state: "connecting", title: "Connecting to FIPS peers" };
}

function readStatus(value: unknown): PublicFipsStatus {
  const status = value as PublicFipsStatus;
  if (
    !status ||
    status.version !== 1 ||
    !["connected", "connecting", "stopped"].includes(status.state) ||
    !Number.isFinite(Date.parse(status.updatedAt)) ||
    !Number.isFinite(Date.parse(status.startedAt)) ||
    !status.descriptor ||
    !/^(02|03)[a-f0-9]{64}$/.test(status.descriptor.peerId) ||
    !/^[a-f0-9]{64}$/.test(status.descriptor.root) ||
    !Array.isArray(status.descriptor.seedUrls) ||
    !status.descriptor.seedUrls.every((url) => typeof url === "string") ||
    !Number.isSafeInteger(status.descriptor.bytes) ||
    status.descriptor.bytes <= 0 ||
    !Number.isSafeInteger(status.descriptor.chunkBytes) ||
    status.descriptor.chunkBytes <= 0 ||
    !Number.isSafeInteger(status.descriptor.servicePort) ||
    typeof status.mapName !== "string" ||
    !Number.isFinite(status.requestTimeoutMs) ||
    !Number.isSafeInteger(status.connectedPeers) ||
    status.connectedPeers < 0 ||
    !status.counters ||
    ![
      "blobLookups",
      "blobBytes",
      "framesSent",
      "framesReceived",
      "bytesSent",
      "bytesReceived",
      "reconnects",
      "invalidFrames",
    ].every((key) => {
      const n = status.counters[key as keyof PublicFipsStatus["counters"]];
      return Number.isSafeInteger(n) && n >= 0;
    })
  )
    throw new Error("The FIPS provider returned an invalid status snapshot.");
  return status;
}

const byteSize = (value: number) => {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(power > 1 ? 2 : 1)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
};
const elapsed = (milliseconds: number) => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (!minutes) return "<1 minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

export function startFips() {
  const section = document.getElementById("fips");
  if (!section) return;
  const el = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(`fips-${id}`)! as T;
  const text = (id: string, value: string) => {
    el(id).textContent = value;
  };
  const refresh = el<HTMLButtonElement>("refresh"),
    auto = el<HTMLInputElement>("auto"),
    interval = el<HTMLSelectElement>("interval");
  let snapshot: PublicFipsStatus | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    freshnessTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false,
    pending: AbortController | undefined;
  const active = () => location.hash === "#fips" && !document.hidden;
  function paint() {
    const view = fipsStatusView(snapshot);
    clearTimeout(freshnessTimer);
    if (
      snapshot &&
      active() &&
      ["connected", "connecting"].includes(view.state)
    )
      freshnessTimer = setTimeout(
        paint,
        Math.max(1, Date.parse(snapshot.updatedAt) + STALE_MS + 1 - Date.now()),
      );
    section!.dataset.state = view.state;
    text("state", view.title);
    if (!snapshot) return;
    const status = snapshot,
      c = status.counters,
      d = status.descriptor;
    text(
      "updated",
      `Snapshot ${new Date(status.updatedAt).toLocaleTimeString()}${view.state === "stale" ? " · provider availability unknown" : ""}`,
    );
    text("peers", status.connectedPeers.toLocaleString());
    text("lookups", c.blobLookups.toLocaleString());
    text("blob-bytes", byteSize(c.blobBytes));
    text(
      "uptime",
      elapsed(Date.parse(status.updatedAt) - Date.parse(status.startedAt)),
    );
    text("map", `${status.mapName} · ${byteSize(d.bytes)}`);
    text("root", d.root);
    text("identity", d.peerId);
    text("blocks", `${byteSize(d.chunkBytes)} / ${d.servicePort}`);
    text("seeds", d.seedUrls.join("\n"));
    text("traffic", `${byteSize(c.bytesSent)} / ${byteSize(c.bytesReceived)}`);
    text(
      "frames",
      `${c.framesSent.toLocaleString()} / ${c.framesReceived.toLocaleString()}`,
    );
    text(
      "reconnects",
      `${c.reconnects.toLocaleString()} / ${c.invalidFrames.toLocaleString()}`,
    );
    text(
      "activity",
      status.lastActivityAt
        ? new Date(status.lastActivityAt).toLocaleString()
        : "No peer reads in this session",
    );
    text(
      "policy",
      `Request deadline: ${status.requestTimeoutMs / 1000} seconds. Provider configuration is read-only here.`,
    );
    text("json", JSON.stringify(d, null, 2));
    el<HTMLButtonElement>("copy").disabled = false;
  }
  function schedule() {
    clearTimeout(timer);
    if (!closed && active() && auto.checked)
      timer = setTimeout(() => void poll(), Number(interval.value) * 1000);
  }
  async function poll() {
    if (closed || pending || !active()) return;
    clearTimeout(timer);
    pending = new AbortController();
    refresh.disabled = true;
    try {
      const response = await fetch("/fips-status.json", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.any([pending.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "No FIPS provider status is available on this host."
            : `Status request failed (HTTP ${response.status}).`,
        );
      snapshot = readStatus(await response.json());
      paint();
      text(
        "message",
        fipsStatusView(snapshot).state === "stale"
          ? "This snapshot is over 30 seconds old. The provider may be stopped or disconnected from status reporting."
          : "The provider runs independently of Atlas map preparation. Refresh settings affect this view only.",
      );
    } catch (error) {
      if (closed) return;
      paint();
      if (!snapshot) text("updated", "No live snapshot");
      text("message", error instanceof Error ? error.message : String(error));
    } finally {
      pending = undefined;
      refresh.disabled = false;
      schedule();
    }
  }
  refresh.onclick = () => void poll();
  auto.onchange = () => {
    interval.disabled = !auto.checked;
    schedule();
  };
  interval.onchange = schedule;
  el<HTMLButtonElement>("copy").onclick = async () => {
    if (!snapshot) return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(
        JSON.stringify(snapshot.descriptor, null, 2),
      );
      text("copy-status", "Connection descriptor copied.");
    } catch {
      el<HTMLDetailsElement>("descriptor").open = true;
      const range = document.createRange();
      range.selectNodeContents(el("json"));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      text("copy-status", "Descriptor selected. Use your copy shortcut.");
    }
  };
  const changed = () => {
    clearTimeout(timer);
    clearTimeout(freshnessTimer);
    if (active()) {
      paint();
      void poll();
    }
  };
  window.addEventListener("hashchange", changed);
  document.addEventListener("visibilitychange", changed);
  window.addEventListener(
    "pagehide",
    () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(freshnessTimer);
      pending?.abort();
      window.removeEventListener("hashchange", changed);
      document.removeEventListener("visibilitychange", changed);
    },
    { once: true },
  );
  if (active()) void poll();
}
