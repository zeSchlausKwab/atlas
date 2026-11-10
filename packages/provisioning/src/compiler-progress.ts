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
      (p.total > 0 && p.completed > p.total) ||
      ![
        "bytes",
        "ways",
        "cells",
        "objects",
        "records",
        "terms",
        "blocks",
      ].includes(p.unit) ||
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
      ...(Number.isSafeInteger(p.stagingBytes) && p.stagingBytes >= 0
        ? { stagingBytes: p.stagingBytes }
        : {}),
      ...(Number.isSafeInteger(p.indexBytes) && p.indexBytes >= 0
        ? { indexBytes: p.indexBytes }
        : {}),
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

/** Rolling throughput is scoped to a single pass; resume work never inflates the rate. */
export class ProgressRate {
  private samples: { at: number; done: number }[] = [];
  private stage = "";
  estimate(stage: string, done: number, total: number, now = Date.now()) {
    const last = this.samples.at(-1);
    if (stage !== this.stage || (last && (done < last.done || now < last.at)))
      this.samples = [];
    this.stage = stage;
    if (this.samples.at(-1)?.at === now) this.samples.pop();
    this.samples.push({ at: now, done });
    while (this.samples.length > 2 && this.samples[1]!.at < now - 180000)
      this.samples.shift();
    const first = this.samples[0]!,
      seconds = (now - first.at) / 1000;
    if (seconds < 15 || done <= first.done || total <= 0) return undefined;
    return Math.max(0, (total - done) / ((done - first.done) / seconds));
  }
}
export function measuredProgress(
  output: (line: string) => void,
  stage: string,
  message: string,
  total: number,
  unit: PreparationProgress["unit"] = "objects",
  start = 0,
) {
  const rate = new ProgressRate(),
    began = Date.now();
  let lastEmission = -Infinity;
  const emit = (completed: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmission < 1000 && completed !== total) return;
    lastEmission = now;
    output(
      "ATLAS_PROGRESS " +
        JSON.stringify({
          stage,
          message,
          completed,
          total,
          unit,
          elapsedSeconds: (Date.now() - began) / 1000,
          etaSeconds: rate.estimate(stage, completed, total),
        }),
    );
  };
  emit(start);
  return emit;
}
