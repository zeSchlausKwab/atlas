import type { BrowserAcquisition } from "./acquisition-client";
import type { WorkspaceMap } from "../../../packages/renderer/src/workspace-map";
import type { Polygon } from "../../../packages/offline/src/geometry";
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1024 ** 2).toFixed(1)} MiB`;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
export class AcquisitionControls {
  private root = document.createElement("section");
  private abort = new AbortController();
  private polygon: Polygon = [];
  private selected = new Set<string>();
  private unsubscribe: () => void;
  constructor(
    readonly client: BrowserAcquisition,
    readonly map: WorkspaceMap,
  ) {
    this.root.className = "saved-areas world-section";
    this.root.innerHTML = `<p class="eyebrow">ACROSS YOUR SELECTED MAPS</p><h2>Save an area here.</h2><p>Keep only the capabilities you need on this device. Verified blocks stay outside the rolling map cache and are reused by the map and AI tools.</p><label>Name<input class="area-name" value="My saved area" maxlength="80"></label><div class="world-actions"><button class="area-view">Use current view</button><button class="area-draw">Draw polygon</button><button class="area-finish" disabled>Finish polygon</button></div><p class="area-outline quiet">Choose an area explicitly. Moving the map won’t change it.</p><fieldset class="area-families"><legend>Capabilities to keep</legend></fieldset><div class="world-zooms"><label>From zoom<input class="area-min" type="number" min="0" max="24" value="10"></label><label>Through zoom<input class="area-max" type="number" min="0" max="24" value="14"></label></div><button class="area-plan primary-button">Review saved area</button><p class="area-status" role="status"></p><p class="quiet">Saved in this browser, not a portable file. Closing the tab pauses work; resume with the same map revisions. Global searches or routes leaving the area can need more data.</p><div class="area-jobs"></div>`;
    document.getElementById("panel-offline")!.prepend(this.root);
    this.el<HTMLButtonElement>("view").onclick = () => {
      const [w, s, e, n] = map.viewBounds();
      this.polygon = [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
      ];
      this.finish();
    };
    this.el<HTMLButtonElement>("draw").onclick = () => {
      this.polygon = [];
      this.el<HTMLButtonElement>("finish").disabled = true;
      this.el("outline").textContent =
        "Click corners, then Finish polygon or press Enter.";
      map.beginPicking(
        "saved-area",
        (p) => {
          this.polygon.push(p);
          map.setSelection(this.polygon, false);
          this.el<HTMLButtonElement>("finish").disabled =
            this.polygon.length < 3;
        },
        () => this.finish(),
        "Draw an area to save",
        () => this.finish(),
      );
    };
    this.el<HTMLButtonElement>("finish").onclick = () => this.finish();
    this.el<HTMLButtonElement>("plan").onclick = () =>
      this.run(async () => {
        if (this.polygon.length < 3)
          throw Error("Choose a rectangle or finish a polygon first.");
        await client.call(
          "plan",
          {
            name: this.el<HTMLInputElement>("name").value,
            polygon: this.polygon,
            families: [...this.selected],
            minZoom: Number(this.el<HTMLInputElement>("min").value),
            maxZoom: Number(this.el<HTMLInputElement>("max").value),
            paddingCells: 1,
            sourceIds: [...new Set(client.sourceIds)],
          },
          this.abort.signal,
        );
      });
    this.unsubscribe = client.subscribe(() => this.render());
    void client
      .call("catalog")
      .then((sources) => {
        if (this.abort.signal.aborted) return;
        const families = [
          ...new Set<string>(sources.flatMap((s: any) => s.families)),
        ].filter(
          (f) =>
            /^(tile:|routing:|raster:|features:)/.test(f) ||
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
        for (const family of families) {
          const label = node("label"),
            check = node("input");
          check.type = "checkbox";
          check.value = family;
          check.checked = [
            "tile:water",
            "tile:roads",
            "routing:walking",
          ].includes(family);
          if (check.checked) this.selected.add(family);
          check.onchange = () => {
            check.checked
              ? this.selected.add(family)
              : this.selected.delete(family);
          };
          const names: Record<string, string> = {
            labels: "Map labels",
            search: "Places & street search data",
            addresses: "House-number addresses",
            query: "Peak queries",
            features: "All extractable features",
            objects: "Source objects & relationships",
            boundaries: "Administrative boundaries",
          };
          label.append(
            check,
            " " +
              (names[family] ??
                family
                  .replace("tile:", "Map · ")
                  .replace("routing:", "Routing · ")
                  .replace("features:", "Extract · ")
                  .replace("raster:", "Imagery · ")),
          );
          this.el("families").append(label);
        }
      })
      .catch((e) => this.status(String(e)));
    this.render();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.root.querySelector<T>(`.area-${id}`)!;
  }
  private status(message: string) {
    this.el("status").textContent = message;
  }
  private finish() {
    this.map.endPicking("saved-area");
    this.map.setSelection(this.polygon, this.polygon.length >= 3);
    this.el<HTMLButtonElement>("finish").disabled = true;
    this.el("outline").textContent =
      this.polygon.length >= 3
        ? `${this.polygon.length} corners · area fixed until you choose another.`
        : "Choose at least three corners.";
  }
  private run(fn: () => Promise<void>) {
    void fn().catch((e) => this.status(String(e)));
  }
  private render() {
    this.el<HTMLButtonElement>("plan").disabled = this.client.busy;
    const list = this.el("jobs");
    list.replaceChildren();
    for (const job of this.client.jobs) {
      const card = node("article"),
        heading = node("h3", job.name),
        state = node("small", job.state),
        message = node("p", job.error ?? job.message),
        actions = node("div");
      card.className = "saved-area-card";
      actions.className = "world-actions";
      card.append(heading, state, message);
      const available = job.request.sourceIds.every((id) =>
        this.client.sourceIds.includes(id),
      );
      const details = node("details"),
        summary = node("summary", "Scope & coverage");
      details.append(
        summary,
        node(
          "p",
          `${job.request.families.join(" · ")} · z${job.request.minZoom}–${job.request.maxZoom}`,
        ),
      );
      if (job.plan) {
        const p = node(
          "p",
          `${size(job.plan.storedBytes)} selected source blocks${job.plan.incomplete ? " · partial coverage" : ""}`,
        );
        card.append(p);
        for (const c of job.plan.coverage)
          details.append(
            node(
              "p",
              `${c.family} z${c.zoom}: ${Object.entries(c.totals)
                .map(
                  ([s, n]) =>
                    `${s} ${(c.areaM2 ? (100 * n) / c.areaM2 : 0).toFixed(1)}%`,
                )
                .join(" · ")}`,
            ),
          );
        for (const c of job.plan.conflicts) details.append(node("p", c));
        for (const note of job.plan.notes) details.append(node("p", note));
      }
      card.append(details);
      const progress = node("progress");
      progress.max = Math.max(1, job.total);
      progress.value = job.completed;
      progress.setAttribute("aria-label", `${job.name} blocks saved`);
      card.append(
        progress,
        node(
          "p",
          `${job.completed.toLocaleString()} / ${job.total.toLocaleString()} blocks · ${size(job.bytes)} fetched · ${size(job.reusedBytes)} reused`,
        ),
      );
      const allowPartial = node("input");
      allowPartial.type = "checkbox";
      const risk = node("input");
      risk.type = "checkbox";
      if (job.plan?.incomplete) {
        const label = node("label");
        label.append(
          allowPartial,
          " Save available coverage despite these gaps",
        );
        card.append(label);
      }
      const storage = node("details"),
        storageLabel = node("label");
      storage.append(node("summary", "Storage options"));
      storageLabel.append(
        risk,
        " Continue if the browser’s free-space estimate is too small",
      );
      storage.append(storageLabel);
      card.append(storage);
      if (this.client.busy && ["fetching", "planning"].includes(job.state)) {
        const pause = node("button", "Pause & keep blocks");
        pause.onclick = () => this.client.pause();
        actions.append(pause);
      } else if (job.state !== "ready") {
        const save = node(
          "button",
          job.state === "review" ? "Save on this device" : "Resume saved area",
        );
        save.disabled =
          this.client.busy || !available || !!job.plan?.conflicts.length;
        save.onclick = () =>
          this.run(async () => {
            await navigator.storage?.persist?.();
            await this.client.call(
              "acquire",
              {
                id: job.id,
                acceptPartial: allowPartial.checked,
                allowStorageRisk: risk.checked,
              },
              this.abort.signal,
            );
          });
        actions.append(save);
      }
      const remove = node("button", "Remove saved area");
      remove.disabled = this.client.busy;
      remove.onclick = () =>
        this.run(async () => {
          await this.client.call("remove", { id: job.id }, this.abort.signal);
        });
      actions.append(remove);
      if (!available)
        card.append(
          node(
            "p",
            "Select the original map revisions to resume. Blocks already saved are still usable.",
          ),
        );
      card.append(actions);
      list.append(card);
    }
  }
  destroy() {
    this.abort.abort();
    this.unsubscribe();
    this.map.endPicking("saved-area");
    this.root.remove();
  }
}
