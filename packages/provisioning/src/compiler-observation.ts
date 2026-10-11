import type { PreparationProgress } from "./selection";
export interface CompilerObservation {
  id: string;
  createdAt: string;
  observedAt: string;
  progress: PreparationProgress;
  stages: { label: string; state: "done" | "active" | "pending" }[];
}
/** Only a fresh observation of this exact job may augment its live status. */
export function currentObservation(
  value: CompilerObservation | undefined,
  job: { id: string; createdAt: string; state: string },
  now = Date.now(),
) {
  if (
    !value ||
    value.id !== job.id ||
    value.createdAt !== job.createdAt ||
    job.state !== "running"
  )
    return;
  const age = now - Date.parse(value.observedAt);
  if (!Number.isFinite(age) || age < -5000 || age > 45000) return;
  return value;
}
