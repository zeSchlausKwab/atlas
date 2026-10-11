import type { PreparationProgress } from "./selection";
/** Native progress describes one measured stage, never an invented whole-build percent. */
export function compilerProgress(
  line: string,
): Partial<PreparationProgress> | undefined {
  if (!line.startsWith("ATLAS_PROGRESS ")) return;
  try {
    const p = JSON.parse(line.slice(15));
    if (
      !Number.isSafeInteger(p.completed) ||
      p.completed < 0 ||
      !Number.isSafeInteger(p.total) ||
      p.total < 0 ||
      p.completed > p.total ||
      !["bytes", "ways", "cells"].includes(p.unit) ||
      typeof p.message !== "string"
    )
      return;
    return {
      message: p.message,
      completed: p.completed,
      total: p.total,
      unit: p.unit,
      stagePercent: p.total ? (100 * p.completed) / p.total : undefined,
      stage: p.stage,
      stageIndex: p.stageIndex,
      stageCount: p.stageCount,
      etaSeconds:
        Number.isFinite(p.etaSeconds) && p.etaSeconds >= 0
          ? p.etaSeconds
          : undefined,
      elapsedSeconds: p.elapsedSeconds,
      checkpointAt: Number.isFinite(p.checkpointAt)
        ? new Date(p.checkpointAt * 1000).toISOString()
        : undefined,
    };
  } catch {
    return;
  }
}
export function approximateDuration(seconds: number) {
  if (seconds < 60) return "less than a minute";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600),
    minutes = Math.ceil((seconds % 3600) / 60);
  return `${hours} h${minutes ? ` ${minutes} min` : ""}`;
}
