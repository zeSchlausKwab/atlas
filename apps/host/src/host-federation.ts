import { hostActivity } from "./host-workbench";
import { createAreaAcquisitions } from "./host-acquisitions";
import { unproject } from "../../../packages/format/src/index";
import type { inspectRouting } from "../../../packages/coverage/src/routing-inspection";
import { createPreview, type HostPreview } from "./host-preview";
import { storageRequest } from "./host-storage";
import {
  COVERAGE_COLORS,
  type CoverageRequest,
  type CoverageReport,
} from "../../../packages/coverage/src/index";
import { type Polygon } from "../../../packages/offline/src/geometry";
import type { Position } from "../../../packages/geocoding/src/model";
import type { Federation } from "../../server/federation";
type State = ReturnType<Federation["view"]>;
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`federation-${id}`) as T;
const text = (tag: string, value: string) => {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
};
const size = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(2)} MiB`
      : `${(n / 1024).toFixed(1)} KiB`;
const rect = ([w, s, e, n]: number[]): Polygon => [
  [w!, s!],
  [e!, s!],
  [e!, n!],
  [w!, n!],
];
const defaults = [
  "tile:water",
  "tile:roads",
  "tile:buildings",
  "routing:walking",
  "routing:cycling",
  "routing:driving",
  "search",
  "addresses",
  "objects",
  "boundaries",
  "features:water",
  "features:buildings",
  "features:roads",
];
async function post(action: string, body: unknown = {}) {
  return storageRequest(`/admin/federation/${action}`, body);
}
export async function startFederation() {
  let state: State | undefined,
    preview: HostPreview | undefined,
    points: Polygon = [],
    closed = false;
  let mode: "rect" | "polygon" | undefined,
    report: CoverageReport | undefined,
    busy = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let renderKey = "",
    known = new Set<string>();
  let routingInspection: Awaited<ReturnType<typeof inspectRouting>> | undefined;
  const selected = new Set<string>();
  const acquisitions = createAreaAcquisitions(
    () => request(),
    () => refresh(),
  );
  const status = (value: string) => {
    el("status").textContent = value;
  };
  const fail = (error: unknown) =>
    status(error instanceof Error ? error.message : String(error));
  const run = (fn: () => Promise<void>) => {
    void fn().catch(fail);
  };
  function invalidate() {
    revision++;
    report = undefined;
    routingInspection = undefined;
    preview?.coverage?.({ type: "FeatureCollection", features: [] });
    el("summary").textContent =
      "Choose an area and capability, then check coverage.";
    el("detail").textContent = "";
    el<HTMLButtonElement>("export").disabled = true;
    el<HTMLButtonElement>("prepare").disabled = true;
  }
  function selection() {
    preview?.selection(points, closed);
    preview?.picking(!!mode);
    el<HTMLButtonElement>("finish").disabled =
      mode !== "polygon" || points.length < 3;
    el("area").textContent = closed
      ? `${points.length} corners · area ready`
      : mode
        ? "Click the map to add corners. Enter finishes; Escape stops drawing."
        : "Draw an area or use the visible map.";
    invalidate();
  }
  function finish() {
    if (points.length >= 3) {
      closed = true;
      mode = undefined;
      selection();
    }
  }
  function pick(p: Position) {
    if (!mode) return;
    if (mode === "rect" && points.length) {
      const a = points[0]!;
      points = rect([
        Math.min(a[0], p[0]),
        Math.min(a[1], p[1]),
        Math.max(a[0], p[0]),
        Math.max(a[1], p[1]),
      ]);
      finish();
    } else {
      points.push(p);
      selection();
    }
  }
  async function makePreview() {
    const view = preview?.view() ?? [8, 45, 20, 51];
    preview?.destroy();
    preview = await createPreview(
      el("map"),
      el<HTMLSelectElement>("preview-provider").value,
      view as [number, number, number, number],
      pick,
      finish,
      () => {
        mode = undefined;
        selection();
      },
      () => {},
    );
    selection();
  }
  function options(id: string, values: Array<[string, string]>) {
    const select = el<HTMLSelectElement>(id),
      previous = select.value;
    select.replaceChildren(
      ...values.map(([value, label]) => new Option(label, value)),
    );
    if (values.some(([v]) => v === previous)) select.value = previous;
  }
  function renderSources(s: State) {
    const key = JSON.stringify([s.peers, s.sources, s.families]);
    if (key === renderKey) return;
    renderKey = key;
    const ids = new Set(s.sources.map((s) => s.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    for (const id of ids) if (!known.has(id)) selected.add(id);
    known = ids;
    options(
      "family",
      [...new Set([...s.families, ...defaults])].map((f) => [
        f,
        f
          .replace(/^tile:/, "Map · ")
          .replace(/^routing:/, "Routing · ")
          .replace(/^features:/, "Extract · "),
      ]),
    );
    options("reference", [
      ["", "Automatic routing reference"],
      ...s.sources
        .filter((s) => s.verified && s.manifest.transport)
        .map((s) => [s.id, s.manifest.name] as [string, string]),
    ]);
    el("peers").replaceChildren(
      ...s.peers.map((peer) => {
        const row = text(
            "p",
            `${peer.url} · key ${peer.pubkey.slice(0, 16)}… ${peer.error ?? ""}`,
          ),
          remove = text("button", "Remove host") as HTMLButtonElement;
        remove.onclick = () =>
          run(async () => {
            await post("remove-peer", { url: peer.url, pubkey: peer.pubkey });
            invalidate();
            await refresh();
          });
        row.append(" ", remove);
        return row;
      }),
    );
    el("sources").replaceChildren(
      ...s.sources.map((source) => {
        const card = text("article", "");
        card.className = "preparation-card";
        const label = text("label", ""),
          input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(source.id);
        input.onchange = () => {
          input.checked ? selected.add(source.id) : selected.delete(source.id);
          invalidate();
        };
        label.append(input, ` ${source.manifest.name}`);
        card.append(
          label,
          text(
            "p",
            `${source.location === "local" ? "On this server" : "Remote host"} · ${source.verified ? "Archive metadata verified" : "Unknown / unavailable"} · ${size(source.bytes)}`,
          ),
        );
        const detail = text(
          "p",
          source.root
            ? `Pinned Hashtree root ${source.root}`
            : `Snapshot ${source.manifest.snapshot}`,
        );
        detail.className = "quiet";
        card.append(detail);
        if (source.error) card.append(text("p", source.error));
        const fit = text("button", "Show extent") as HTMLButtonElement;
        fit.onclick = () => preview?.fitArea(source.manifest.bounds);
        card.append(fit);
        if (source.canMirror) {
          const mirror = text(
            "button",
            "Mirror whole .atlas",
          ) as HTMLButtonElement;
          mirror.onclick = () =>
            run(async () => {
              mirror.disabled = true;
              try {
                await post("mirror", { id: source.id });
                await refresh();
              } finally {
                mirror.disabled = false;
              }
            });
          card.append(" ", mirror);
        }
        return card;
      }),
    );
    if (!s.sources.length)
      el("sources").append(
        text(
          "p",
          "No verified sources yet. Refresh the library or add a publishing Atlas host.",
        ),
      );
    invalidate();
  }
  function renderMirrors(s: State) {
    hostActivity(
      "Mirror",
      "federation",
      s.mirrors.map((m) => ({
        id: m.id,
        name: m.name,
        state: m.state,
        message: m.error,
        completed: m.offset,
        total: m.bytes,
      })),
    );
    el("mirrors").replaceChildren(
      ...s.mirrors.map((m) => {
        const card = text("article", "");
        card.className = "preparation-card";
        card.append(
          text("h3", m.name),
          text("p", `${m.state} · ${size(m.offset)} / ${size(m.bytes)}`),
        );
        const progress = document.createElement("progress");
        progress.max = m.bytes;
        progress.value = m.offset;
        progress.setAttribute("aria-label", `${m.name} mirror progress`);
        card.append(progress);
        if (m.error) card.append(text("p", m.error));
        if (m.state === "queued-import" || m.state === "ready") {
          const link = text(
            "a",
            m.state === "ready"
              ? "View mirrored archive in library · refresh coverage to include it"
              : "View import in Builds & checkpoints",
          ) as HTMLAnchorElement;
          link.href = m.state === "ready" ? "#library" : "#builds";
          card.append(link);
        } else {
          const action = m.state === "downloading" ? "pause" : "resume",
            button = text(
              "button",
              action === "pause" ? "Pause mirror" : "Resume mirror",
            ) as HTMLButtonElement;
          button.onclick = () =>
            run(async () => {
              button.disabled = true;
              await post(action, { id: m.id });
              await refresh();
            });
          card.append(button);
          if (action === "resume") {
            const remove = text(
              "button",
              "Delete partial download",
            ) as HTMLButtonElement;
            remove.onclick = () =>
              run(async () => {
                if (confirm(`Delete the partial download of ${m.name}?`)) {
                  await post("delete-mirror", { id: m.id });
                  await refresh();
                }
              });
            card.append(" ", remove);
          }
        }
        return card;
      }),
    );
  }
  async function refresh() {
    clearTimeout(timer);
    try {
      const r = await fetch("/admin/federation", { cache: "no-store" });
      const s = await r.json();
      if (!r.ok) throw Error(s.error ?? "Coverage service unavailable");
      state = s;
      renderSources(s);
      renderMirrors(s);
      acquisitions.render(s);
      status(s.status);
      el<HTMLButtonElement>("refresh").disabled = s.refreshing;
    } finally {
      timer = setTimeout(
        () => run(refresh),
        state?.refreshing ||
          state?.mirrors.some((m) => m.state === "downloading") ||
          state?.acquisitions.some((j) =>
            ["planning", "fetching", "packing"].includes(j.state),
          )
          ? 2000
          : 10000,
      );
    }
  }
  function request(): CoverageRequest {
    if (!closed) throw Error("Finish the selected area first.");
    return {
      polygon: points,
      family: el<HTMLSelectElement>("family").value,
      zoom: Number(el<HTMLInputElement>("zoom").value),
      reference: el<HTMLSelectElement>("reference").value || undefined,
      sourceIds: [...selected],
    };
  }
  el("plan").onclick = () =>
    run(async () => {
      if (busy) return;
      busy = true;
      const button = el<HTMLButtonElement>("plan");
      button.disabled = true;
      invalidate();
      const epoch = revision;
      try {
        const result = await post("plan", request());
        if (epoch !== revision) return;
        report = result;
        const r = report!;
        preview?.coverage?.({
          ...r.regions,
          features: r.regions.features.map((f) => ({
            ...f,
            properties: {
              ...f.properties,
              color: COVERAGE_COLORS[f.properties.state],
            },
          })),
        });
        el("summary").replaceChildren(
          ...Object.entries(r.totals).map(([state, n]) => {
            const p = text(
              "p",
              `${state === "remote" ? "Remote verified" : state} · ${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} km² · ${((100 * n) / r.areaM2).toFixed(1)}%`,
            );
            p.style.borderColor =
              COVERAGE_COLORS[state as keyof typeof COVERAGE_COLORS];
            return p;
          }),
          ...r.notes.map((n) => text("p", n)),
        );
        if (r.fullArchiveDownloadBytes)
          el("summary").append(
            text(
              "p",
              `Mirroring every matching remote archive would transfer ${size(r.fullArchiveDownloadBytes)}. This is whole-file size, not just the selected area.`,
            ),
          );
        if (r.reference && r.request.family.startsWith("routing:"))
          el("summary").append(
            text(
              "p",
              `Routing reference: ${state?.sources.find((s) => s.id === r.reference)?.manifest.name ?? r.reference}`,
            ),
          );
        el<HTMLButtonElement>("export").disabled = false;
        el<HTMLButtonElement>("prepare").disabled = !(
          /^(tile:|routing:|features:)/.test(r.request.family) ||
          [
            "search",
            "addresses",
            "labels",
            "query",
            "features",
            "objects",
            "boundaries",
          ].includes(r.request.family)
        );
        status(
          `Coverage checked at ${new Date(r.checkedAt).toLocaleTimeString()}.`,
        );
      } finally {
        busy = false;
        button.disabled = false;
      }
    });
  el("inspect").onclick = () =>
    run(async () => {
      const req = request();
      if (!req.family.startsWith("routing:"))
        throw Error("Select a routing capability for directory inspection.");
      const epoch = revision;
      const button = el<HTMLButtonElement>("inspect");
      button.disabled = true;
      el("detail").textContent = "Reading verified routing directories…";
      try {
        const detail: Awaited<ReturnType<typeof inspectRouting>> = await post(
          "inspect",
          req,
        );
        if (epoch !== revision) return;
        routingInspection = detail;
        const colors = {
          present: "#347da7",
          empty: "#a9c5b0",
          missing: "#bf513c",
          conflict: "#9a528d",
          unknown: "#a48739",
          incompatible: "#9a528d",
        };
        preview?.coverage?.({
          type: "FeatureCollection",
          features: detail.cells.map((cell) => {
            const ring = rect([
              ...unproject(cell.x / 16384, (cell.y + 1) / 16384),
              ...unproject((cell.x + 1) / 16384, cell.y / 16384),
            ]);
            return {
              type: "Feature",
              properties: { color: colors[cell.state] },
              geometry: { type: "Polygon", coordinates: [[...ring, ring[0]!]] },
            };
          }),
        });
        el("detail").replaceChildren(
          text(
            "p",
            Object.entries(detail.counts)
              .map(([k, v]) => `${v} ${k}`)
              .join(" · "),
          ),
          text(
            "p",
            "Routing cells: blue = present, pale green = empty, red = missing, purple = conflict/incompatible, amber = unknown. Directory check only; graph payloads and connectivity were not checked.",
          ),
        );
      } catch (e) {
        el("detail").textContent = String(e);
      } finally {
        button.disabled = false;
      }
    });
  el("export").onclick = () => {
    if (!report) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify({ ...report, routingInspection }, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = `atlas-coverage-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el("prepare").onclick = () => {
    if (report)
      document.dispatchEvent(
        new CustomEvent("atlas-coverage-prepare", { detail: report.request }),
      );
  };
  el("peer-form").onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      status("Checking publisher identity…");
      await post("peer", {
        url: el<HTMLInputElement>("peer-url").value,
        pubkey: el<HTMLInputElement>("peer-pubkey").value.trim() || undefined,
      });
      await refresh();
    });
  };
  el("refresh").onclick = () =>
    run(async () => {
      await post("refresh");
      await refresh();
    });
  for (const id of ["family", "zoom", "reference"])
    el(id).onchange = invalidate;
  for (const kind of ["rect", "polygon"] as const)
    el(kind).onclick = () => {
      mode = kind;
      points = [];
      closed = false;
      selection();
    };
  el("finish").onclick = finish;
  el("clear").onclick = () => {
    points = [];
    closed = false;
    mode = undefined;
    selection();
  };
  el("view").onclick = () => {
    if (preview) {
      points = rect(preview.view());
      closed = true;
      mode = undefined;
      selection();
    }
  };
  el("preview-provider").onchange = () => run(makePreview);
  // Keep the existing host console useful even if a publisher or preview is offline.
  await Promise.all([makePreview().catch(fail), refresh().catch(fail)]);
  run(async () => {
    await post("refresh");
    await refresh();
  });
}
