import { updateClientDiscovery } from "./client-link";
interface FipsStatus {
  version: 2;
  state: "connected" | "connecting" | "stopped" | "failed";
  updatedAt: string;
  startedAt: string;
  error?: string;
  peerId?: string;
  settings: {
    enabled: boolean;
    httpEnabled: boolean;
    seedUrls: string[];
    relayUrls: string[];
  };
  connectedPeers: string[];
  counters: {
    blobLookups: number;
    blobBytes: number;
    rpcRequests: number;
    websocket: Record<string, number>;
  };
  discovery: { pubkey: string; relays: string[] };
  maps: Array<{
    id: string;
    name: string;
    root: string;
    bytes: number;
    publication?: string;
    relayErrors: string[];
  }>;
}
const STALE_MS = 30_000;
export function fipsStatusView(
  status: { state: string; updatedAt: string } | undefined,
  now = Date.now(),
) {
  if (!status) return { state: "unavailable", title: "Status unavailable" };
  if (status.state === "stopped")
    return { state: "stopped", title: "FIPS delivery is off" };
  if (status.state === "failed")
    return { state: "failed", title: "FIPS needs attention" };
  if (now - Date.parse(status.updatedAt) > STALE_MS)
    return { state: "stale", title: "Status is stale" };
  return status.state === "connected"
    ? { state: "connected", title: "Connected to the FIPS network" }
    : { state: "connecting", title: "Connecting to FIPS peers" };
}
const byteSize = (value: number) => {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(power > 1 ? 2 : 1)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
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
  let snapshot: FipsStatus | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false,
    pending: AbortController | undefined,
    settingsLoaded = false;
  const active = () => location.hash === "#fips" && !document.hidden;
  function paint() {
    const view = fipsStatusView(snapshot);
    section!.dataset.state = view.state;
    text("state", view.title);
    if (!snapshot) return;
    const s = snapshot,
      c = s.counters,
      w = c.websocket;
    text("updated", `Snapshot ${new Date(s.updatedAt).toLocaleTimeString()}`);
    text("peers", s.connectedPeers.length.toLocaleString());
    text(
      "lookups",
      `${c.blobLookups.toLocaleString()} / ${c.rpcRequests.toLocaleString()}`,
    );
    text("blob-bytes", byteSize(c.blobBytes));
    text(
      "uptime",
      `${Math.max(0, Math.floor((Date.parse(s.updatedAt) - Date.parse(s.startedAt)) / 60_000))} min`,
    );
    text(
      "map",
      `${s.maps.length} published maps · ${byteSize(s.maps.reduce((n, m) => n + m.bytes, 0))}`,
    );
    text("root", `${s.maps.length} independently verified Hashtree roots`);
    text("identity", s.peerId ?? "No active FIPS identity");
    text("blocks", "64 KiB typical blocks · data 39018 · operations 39019");
    text("seeds", s.settings.seedUrls.join("\n"));
    text(
      "traffic",
      `${byteSize(w.bytesSent ?? 0)} / ${byteSize(w.bytesReceived ?? 0)}`,
    );
    text(
      "frames",
      `${(w.framesSent ?? 0).toLocaleString()} / ${(w.framesReceived ?? 0).toLocaleString()}`,
    );
    text(
      "reconnects",
      `${(w.reconnectsScheduled ?? 0).toLocaleString()} / ${(w.invalidFrames ?? 0).toLocaleString()}`,
    );
    text("activity", "Live counters include all published maps");
    text(
      "policy",
      `FIPS ${s.settings.enabled ? "enabled" : "off"} · HTTP map delivery ${s.settings.httpEnabled ? "enabled" : "off"}. Administration stays on this local/LAN address.`,
    );
    const list = el("maps");
    list.replaceChildren();
    for (const map of s.maps) {
      const item = document.createElement("details"),
        summary = document.createElement("summary"),
        info = document.createElement("p"),
        root = document.createElement("code");
      summary.textContent = `${map.name} · ${byteSize(map.bytes)}`;
      info.textContent = map.relayErrors.length
        ? `Discovery relay delivery pending: ${map.relayErrors.join("; ")}`
        : (map.publication ?? "Published");
      root.textContent = map.root;
      item.append(summary, info, root);
      list.append(item);
    }
    text(
      "json",
      JSON.stringify(
        {
          discovery: s.discovery,
          providers: {
            peerId: s.peerId,
            seedUrls: s.settings.seedUrls,
            servicePort: 39018,
            rpcPort: 39019,
          },
          maps: s.maps.map(({ id, root }) => ({ id, root })),
        },
        null,
        2,
      ),
    );
    el<HTMLButtonElement>("copy").disabled = !s.peerId;
    if (!settingsLoaded) {
      el<HTMLInputElement>("enabled").checked = s.settings.enabled;
      el<HTMLInputElement>("http").checked = s.settings.httpEnabled;
      el<HTMLTextAreaElement>("seed-input").value =
        s.settings.seedUrls.join("\n");
      el<HTMLTextAreaElement>("relay-input").value =
        s.settings.relayUrls.join("\n");
      settingsLoaded = true;
    }
    text(
      "message",
      s.error ??
        (!s.settings.relayUrls.length
          ? "Choose at least one discovery relay so consumers can find this host without an HTTP address."
          : "Enabled library maps share this provider. Signed announcements carry coverage, capabilities and transport details."),
    );
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
        signal: AbortSignal.any([pending.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok)
        throw new Error(`Status request failed (HTTP ${response.status})`);
      const value = await response.json();
      if (
        value.version !== 2 ||
        !Array.isArray(value.maps) ||
        !value.settings ||
        !value.discovery
      )
        throw new Error("This host needs the integrated FIPS provider update.");
      snapshot = value;
      paint();
    } catch (error) {
      if (!closed) text("message", String(error));
    } finally {
      pending = undefined;
      refresh.disabled = false;
      schedule();
    }
  }
  el<HTMLFormElement>("settings").onsubmit = async (event) => {
    event.preventDefault();
    const save = el<HTMLButtonElement>("save");
    save.disabled = true;
    text(
      "settings-status",
      "Applying delivery settings and updating signed announcements…",
    );
    const urls = (id: string) =>
      el<HTMLTextAreaElement>(id)
        .value.split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    try {
      const response = await fetch("/admin/fips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: el<HTMLInputElement>("enabled").checked,
          httpEnabled: el<HTMLInputElement>("http").checked,
          seedUrls: urls("seed-input"),
          relayUrls: urls("relay-input"),
        }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `HTTP ${response.status}`);
      snapshot = value;
      settingsLoaded = false;
      paint();
      updateClientDiscovery(value.discovery, value.settings.enabled);
      text(
        "settings-status",
        value.error
          ? `Settings saved; provider needs attention: ${value.error}`
          : "Settings saved. Map files and build checkpoints are unchanged.",
      );
    } catch (error) {
      text("settings-status", String(error));
    } finally {
      save.disabled = false;
    }
  };
  refresh.onclick = () => void poll();
  auto.onchange = () => {
    interval.disabled = !auto.checked;
    schedule();
  };
  interval.onchange = schedule;
  el<HTMLButtonElement>("copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(el("json").textContent!);
      text("copy-status", "Connection descriptor copied.");
    } catch {
      el<HTMLDetailsElement>("descriptor").open = true;
      text("copy-status", "Copy the descriptor below.");
    }
  };
  const changed = () => {
    clearTimeout(timer);
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
      pending?.abort();
      window.removeEventListener("hashchange", changed);
      document.removeEventListener("visibilitychange", changed);
    },
    { once: true },
  );
  if (active()) void poll();
}
