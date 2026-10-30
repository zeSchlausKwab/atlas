import { storageRequest } from "./host-storage";
import type { CoverageRequest } from "../../../packages/coverage/src/index";
import type { Federation } from "../../server/federation";
type State = ReturnType<Federation["view"]>;
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById("area-" + id) as T;
const node = (tag: string, value: string) => {
  const n = document.createElement(tag);
  n.textContent = value;
  return n;
};
const size = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(2)} MiB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${n} B`;
const label = (id: string) =>
  id
    .replace("tile:", "Map · ")
    .replace("routing:", "Routing · ")
    .replace("raster:", "Imagery · ")
    .replace("features:", "Extract · ")
    .replace(/^addresses$/, "Explicit house-number addresses")
    .replace(/^search$/, "Search & reverse geocoding")
    .replace(/^query$/, "Peak queries")
    .replace(/^features$/, "Feature extraction")
    .replace(/^labels$/, "Place, street & POI labels")
    .replace(/^boundaries$/, "Administrative boundaries")
    .replace(/^objects$/, "Tagged objects & relationships");
export function createAreaAcquisitions(
  request: () => CoverageRequest,
  refresh: () => Promise<void>,
) {
  const selected = new Set([
    "tile:water",
    "tile:roads",
    "tile:buildings",
    "search",
    "routing:walking",
  ]);
  const partial = new Set<string>();
  let familyKey = "",
    jobsKey = "";
  const run = (fn: () => Promise<void>) => {
    void fn().catch((e) => (el("status").textContent = String(e)));
  };
  const post = (action: string, body: unknown) =>
    storageRequest("/admin/federation/area-" + action, body);
  el("review").onclick = () =>
    run(async () => {
      const button = el<HTMLButtonElement>("review");
      button.disabled = true;
      try {
        const scope = request();
        await post("plan", {
          name: el<HTMLInputElement>("name").value,
          polygon: scope.polygon,
          sourceIds: scope.sourceIds,
          reference: scope.reference,
          families: [
            ...el("families").querySelectorAll<HTMLInputElement>(
              "input:checked",
            ),
          ].map((n) => n.value),
          minZoom: Number(el<HTMLInputElement>("min-zoom").value),
          maxZoom: Number(el<HTMLInputElement>("max-zoom").value),
          paddingCells: Number(el<HTMLInputElement>("padding").value),
        });
        el("status").textContent =
          "Planning in the background. You can leave this page.";
        await refresh();
      } finally {
        button.disabled = false;
      }
    });
  return {
    render(state: State) {
      const families = state.families.filter(
        (f) =>
          /^(tile:(land|water|buildings|roads|railways|peaks)|routing:(walking|cycling|driving)|raster:|features:)/.test(
            f,
          ) ||
          [
            "labels",
            "search",
            "addresses",
            "query",
            "features",
            "objects",
            "boundaries",
          ].includes(f),
      );
      const key = JSON.stringify(families);
      if (key !== familyKey) {
        familyKey = key;
        el("families").replaceChildren(
          node("legend", "Include these capabilities"),
          ...families.map((f) => {
            const row = node("label", "");
            const input = document.createElement("input");
            input.type = "checkbox";
            input.value = f;
            input.checked = selected.has(f);
            input.onchange = () => {
              input.checked ? selected.add(f) : selected.delete(f);
            };
            row.append(input, " " + label(f));
            row.style.display = "block";
            return row;
          }),
        );
      }
      el<HTMLButtonElement>("review").disabled = state.acquisitions.some((j) =>
        ["planning", "fetching", "packing"].includes(j.state),
      );
      const jk = JSON.stringify(state.acquisitions);
      if (jk === jobsKey) return;
      jobsKey = jk;
      el("jobs").replaceChildren(
        ...state.acquisitions.map((j) => {
          const card = node("article", "");
          card.className = "preparation-card";
          card.append(
            node("h3", j.request.name),
            node("p", `${j.state} · ${j.message}`),
          );
          card.append(
            node(
              "p",
              `${j.request.families.map(label).join(" · ")} · z${j.request.minZoom}–${j.request.maxZoom}`,
            ),
          );
          const progress = document.createElement("progress");
          progress.max = Math.max(1, j.total);
          if (j.total && j.state === "fetching") progress.value = j.completed;
          progress.setAttribute(
            "aria-label",
            `${j.request.name} acquisition progress`,
          );
          if (["planning", "fetching", "packing"].includes(j.state))
            card.append(progress);
          if (j.total)
            card.append(
              node(
                "p",
                `${j.completed.toLocaleString()}/${j.total.toLocaleString()} blocks · ${size(j.bytes)} read · ${size(j.reusedBytes)} reused from cache`,
              ),
            );
          if (j.state === "review")
            card.append(
              node(
                "p",
                `${size(j.reusedBytes)} of selected blocks already cached during planning`,
              ),
            );
          if (j.error) card.append(node("p", j.error));
          const action = (title: string, fn: () => Promise<void>) => {
            const b = node("button", title) as HTMLButtonElement;
            b.onclick = () =>
              run(async () => {
                b.disabled = true;
                try {
                  await fn();
                  await refresh();
                } finally {
                  b.disabled = false;
                }
              });
            card.append(" ", b);
            return b;
          };
          if (j.plan) {
            card.append(
              node(
                "p",
                `${size(j.plan.localBytes)} in local source files · ${size(j.plan.remoteBytes)} remote blocks · ${j.plan.blocks.toLocaleString()} block references · ${j.plan.members} source members`,
              ),
            );
            const detail = document.createElement("details");
            detail.append(node("summary", "Coverage & dependency review"));
            for (const c of j.plan.coverage) {
              const pct = (n: number) =>
                ((100 * n) / c.areaM2).toFixed(1) + "%";
              detail.append(
                node(
                  "p",
                  `${label(c.family)} at z${c.zoom}: ${pct(c.totals.local)} local · ${pct(c.totals.remote)} remote · ${pct(c.totals.missing)} missing · ${pct(c.totals.unknown)} unknown · ${pct(c.totals.incompatible)} incompatible`,
                ),
              );
            }
            for (const note of j.plan.notes) detail.append(node("p", note));
            if (j.plan.conflicts.length)
              detail.append(
                node(
                  "p",
                  `${j.plan.conflicts.length} conflicting routing cells. Choose compatible providers; acquisition is blocked.`,
                ),
              );
            card.append(detail);
            if (j.plan.incomplete && j.state !== "ready") {
              const row = node("label", "");
              const input = document.createElement("input");
              input.type = "checkbox";
              input.checked = partial.has(j.id) || !!j.acceptedPartial;
              input.onchange = () => {
                input.checked ? partial.add(j.id) : partial.delete(j.id);
              };
              row.append(
                input,
                " Acquire available data and keep the coverage gaps in the report",
              );
              card.append(row);
            }
          }
          if (["planning", "fetching", "packing"].includes(j.state))
            action("Pause & keep blocks", () => post("pause", { id: j.id }));
          else if (j.state !== "ready") {
            const b = action(
              j.state === "review"
                ? "Acquire selected data"
                : "Resume acquisition",
              () =>
                post("resume", { id: j.id, acceptPartial: partial.has(j.id) }),
            );
            b.disabled = !!j.plan?.conflicts.length;
          } else {
            const a = node("a", "Download .atlas") as HTMLAnchorElement;
            a.href = `/admin/federation/area-file/${j.id}`;
            a.download = "";
            card.append(a);
            const b = action(
              j.imported ? "Queued in map library" : "Add to map library",
              () => post("publish", { id: j.id }),
            );
            b.disabled = !!j.imported;
            card.append(
              node(
                "p",
                "Open the downloaded file in the client, or publish the imported map with Hashtree from your map library.",
              ),
            );
          }
          if (!["planning", "fetching", "packing"].includes(j.state))
            action("Delete acquisition & cache…", async () => {
              if (
                confirm(
                  `Delete ${j.request.name}'s acquisition, export and cache? Any copy already added to the map library stays there.`,
                )
              )
                await post("delete", { id: j.id });
            });
          return card;
        }),
      );
    },
  };
}
