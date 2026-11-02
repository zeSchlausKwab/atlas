import type { PreparationJob } from "../../server/preparations";
import type { CompilerObservation } from "../../../packages/provisioning/src/compiler-observation";
import { approximateDuration } from "../../../packages/provisioning/src/compiler-progress";
import { storageSize } from "./host-budget";

type Stage = { label: string; state: "done" | "active" | "pending" };
/** Keep the running work in view; queue order is FIFO, not reverse creation time. */
export function orderBuildJobs<
  T extends Pick<PreparationJob, "state" | "createdAt">,
>(jobs: T[]): T[] {
  const rank = (s: T["state"]) =>
    ["running", "cancelling"].includes(s)
      ? 0
      : s === "failed"
        ? 1
        : s === "queued"
          ? 2
          : s === "ready"
            ? 4
            : 3;
  return [...jobs].sort(
    (a, b) =>
      rank(a.state) - rank(b.state) ||
      (a.state === "queued" && b.state === "queued"
        ? a.createdAt.localeCompare(b.createdAt)
        : 0),
  );
}
/** Ordered compiler passes, even when an old worker only sends text counters. */
function inferredStages(job: PreparationJob): Stage[] {
  if (!job.cachedSource) return [];
  const s = job.selection,
    p = job.progress;
  const semantic =
    s.featureKinds.length ||
    s.search ||
    s.reverse ||
    s.placeNames ||
    s.streetNames ||
    s.pois ||
    s.peaks;
  const names = [
    "PBF extraction",
    ...(s.profiles.length ? ["Routing graphs"] : []),
    ...(semantic || s.layers.length ? ["Source geometry"] : []),
    ...(semantic ? ["Search, labels & features"] : []),
    ...(s.layers.length ? ["Display tiles"] : []),
    "Assembly & verification",
  ];
  const detail = `${p.stage ?? ""} ${p.message}`.toLowerCase();
  let label: string | undefined;
  if (
    ["planning", "downloading", "extracting"].includes(p.phase) ||
    /saved extraction|ocean source|ocean input|sea polygons/.test(detail)
  )
    label = names[0];
  else if (
    /semantic|search|labels|source objects|object-|tag.value|named street|location/.test(
      detail,
    )
  )
    label = "Search, labels & features";
  else if (/display|tiling|tile|building heights/.test(detail))
    label = "Display tiles";
  else if (
    /source.*(?:sqlite|geometry|nodes|ways|relations)|source-/.test(detail)
  )
    label = "Source geometry";
  else if (/routing|graph|transport|partitioning|restriction/.test(detail))
    label = "Routing graphs";
  else if (
    /assembly|final|packing|verifying|indexing/.test(`${p.phase} ${detail}`)
  )
    label = "Assembly & verification";
  const active = label ? names.indexOf(label) : -1;
  // Unknown text must not falsely mark earlier stages complete.
  return names.map((label, i) => ({
    label,
    state:
      active < 0
        ? "pending"
        : i < active
          ? "done"
          : i === active
            ? "active"
            : "pending",
  }));
}
export function buildProgressModel(
  job: PreparationJob,
  view?: CompilerObservation,
) {
  const p = view?.progress ?? job.progress;
  const stages = view?.stages ?? inferredStages({ ...job, progress: p });
  const legacy = p.message.match(
    /(?:·|:)\s*([\d,]+)\s*(objects|ways|cells|records|terms|blocks)\s*$/i,
  );
  const count = legacy ? Number(legacy[1].replaceAll(",", "")) : p.completed;
  const unit = legacy ? legacy[2] : (p.unit ?? "blocks");
  const total = p.total > 0 ? p.total : undefined;
  const percent =
    p.stagePercent ?? (total ? (100 * p.completed) / total : undefined);
  const elapsed = p.elapsedSeconds;
  const eta = p.etaSeconds;
  const active = stages.findIndex((s) => s.state === "active");
  return {
    stages,
    step:
      active >= 0
        ? `Step ${active + 1} of ${stages.length}`
        : p.phase.charAt(0).toUpperCase() + p.phase.slice(1),
    title: active >= 0 ? stages[active].label : p.phase,
    percent:
      percent !== undefined && Number.isFinite(percent)
        ? Math.min(100, Math.max(0, percent))
        : undefined,
    counter: total
      ? unit === "bytes"
        ? `${storageSize(p.completed)} / ${storageSize(total)}`
        : `${p.completed.toLocaleString()} / ${total.toLocaleString()} ${unit}`
      : count > 0 && unit !== "stages"
        ? unit === "bytes"
          ? `${storageSize(count)} processed`
          : `${count.toLocaleString()} ${unit} processed`
        : undefined,
    elapsed:
      Number.isFinite(elapsed) && elapsed! >= 0
        ? approximateDuration(elapsed!)
        : undefined,
    observed:
      elapsed === undefined && view?.observedElapsedSeconds !== undefined
        ? approximateDuration(view.observedElapsedSeconds)
        : undefined,
    eta:
      Number.isFinite(eta) && eta! >= 0 ? approximateDuration(eta!) : undefined,
    checkpoint:
      p.checkpointAt && Number.isFinite(Date.parse(p.checkpointAt))
        ? new Date(p.checkpointAt).toLocaleTimeString()
        : undefined,
    saved: storageSize(p.writtenBytes),
    substep:
      p.stageIndex && p.stageCount
        ? `Routing pass ${p.stageIndex} of ${p.stageCount}`
        : undefined,
  };
}
const element = (tag: string, value: string, className = "") => {
  const e = document.createElement(tag);
  e.textContent = value;
  e.className = className;
  return e;
};
export function buildProgressPanel(
  job: PreparationJob,
  view?: CompilerObservation,
) {
  const m = buildProgressModel(job, view),
    panel = element("section", "", "build-progress-panel");
  panel.setAttribute("aria-label", `Build progress for ${job.name}`);
  const heading = element("div", "", "build-progress-heading");
  heading.append(
    element("span", m.step),
    element(
      "strong",
      m.percent === undefined ? "Working…" : `${m.percent.toFixed(1)}%`,
    ),
  );
  panel.append(heading);
  if (m.stages.length) {
    const stages = element("ol", "", "build-stage-list");
    stages.setAttribute("aria-label", "Preparation stages");
    for (const stage of m.stages) {
      const item = element(
        "li",
        `${stage.state === "done" ? "✓" : stage.state === "active" ? "●" : "○"} ${stage.label}`,
      );
      item.dataset.state = stage.state;
      if (stage.state === "active") item.setAttribute("aria-current", "step");
      stages.append(item);
    }
    panel.append(stages);
  }
  const bar = document.createElement("progress");
  bar.max = 100;
  if (m.percent !== undefined) bar.value = m.percent;
  bar.setAttribute("aria-label", `Current pass for ${job.name}`);
  panel.append(bar);
  if (m.substep)
    panel.append(element("p", m.substep, "build-progress-counter"));
  if (m.counter)
    panel.append(element("p", m.counter, "build-progress-counter"));
  const metrics = element("dl", "", "build-progress-metrics");
  const metric = (label: string, value: string) => {
    const item = element("div", "");
    item.append(element("dt", label), element("dd", value));
    metrics.append(item);
  };
  metric(
    "This pass remaining",
    m.eta
      ? `≈ ${m.eta}`
      : m.percent !== undefined
        ? "Estimating…"
        : "Total not reported yet",
  );
  if (m.elapsed) metric("This pass elapsed", m.elapsed);
  else if (m.observed) metric("Observed this pass", m.observed);
  metric(job.cachedSource ? "Saved stage data" : "Atlas written", m.saved);
  if (m.checkpoint) metric("Last checkpoint", m.checkpoint);
  panel.append(
    metrics,
    element(
      "p",
      "Progress and ETA describe this pass, not the whole build.",
      "build-progress-note",
    ),
  );
  if (job.cachedSource)
    panel.append(
      element(
        "p",
        m.checkpoint
          ? "Saved checkpoints can be reused; unfinished work may repeat after a stop."
          : "Checkpoint details have not been reported for this step. Completed stages are kept when stopped.",
        "build-progress-note",
      ),
    );
  return panel;
}
