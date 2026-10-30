import type { AcquisitionPlan, AcquisitionRequest } from "./plan";
export interface SavedArea {
  id: string;
  request: AcquisitionRequest;
  state: "planning" | "review" | "fetching" | "paused" | "failed" | "ready";
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completed: number;
  total: number;
  bytes: number;
  reusedBytes: number;
  sources: Array<{ id: string; snapshot: string }>;
  plan?: AcquisitionPlan;
}
/** Browser ownership is per snapshot/key, whereas portable export deduplicates by hash. */
export function browserPlanBytes(plan: AcquisitionPlan) {
  const blocks = new Map<string, number>();
  for (const part of plan.parts)
    for (const b of part.blocks)
      blocks.set(`${part.sourceId}:${b.key}:${b.hash}`, b.length);
  return [...blocks.values()].reduce((sum, n) => sum + n, 0);
}
const summaries = new WeakMap<
  AcquisitionPlan,
  {
    storedBytes: number;
    incomplete: boolean;
    conflicts: string[];
    notes: string[];
    coverage: Array<{
      family: string;
      zoom: number;
      totals: AcquisitionPlan["coverage"][number]["totals"];
      areaM2: number;
    }>;
  }
>();
function review(plan: AcquisitionPlan) {
  const existing = summaries.get(plan);
  if (existing) return existing;
  const value = {
    storedBytes: browserPlanBytes(plan),
    incomplete: plan.incomplete,
    conflicts: plan.conflicts,
    notes: [
      "Source cells touching the area can extend beyond it. Selected blocks retain their source revision and geometry.",
      "Spatial locations are saved; global text-search indexes are not rebuilt or fully downloaded.",
      "This saves source blocks in browser storage, not a portable Atlas file.",
    ],
    coverage: plan.coverage.map((c) => ({
      family: c.request.family,
      zoom: c.request.zoom,
      totals: c.totals,
      areaM2: c.areaM2,
    })),
  };
  summaries.set(plan, value);
  return value;
}
export const areaSummary = (j: SavedArea) => ({
  id: j.id,
  name: j.request.name,
  state: j.state,
  message: j.message,
  error: j.error,
  request: j.request,
  completed: j.completed,
  total: j.total,
  bytes: j.bytes,
  reusedBytes: j.reusedBytes,
  updatedAt: j.updatedAt,
  plan: j.plan && review(j.plan),
  scope:
    "Verified source blocks pinned in this browser, not a standalone .atlas export. Browser storage can be cleared or evicted. Spatial analysis and routing reuse these blocks; full-text search, relations outside the selection and routes leaving it may need additional reads.",
});
export type SavedAreaView = ReturnType<typeof areaSummary>;

/** Full dependency lists live separately, so progress never rewrites a large plan. */
export type SavedAreaRecord = Omit<SavedArea, "plan"> & {
  review?: SavedAreaView["plan"];
  plan?: AcquisitionPlan;
};
