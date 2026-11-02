import type { PreparationProgress } from "./selection";
export interface CompilerPassCounter {
  stage: string;
  message: string;
  completed: number;
  total: number;
  unit: NonNullable<PreparationProgress["unit"]>;
}
/** Preserve measured counters across pass changes without inventing completion. */
export class CompilerPassHistory {
  private counters = new Map<string, CompilerPassCounter>();
  record(p: Partial<PreparationProgress>) {
    if (
      !p.stage ||
      !p.unit ||
      p.unit === "stages" ||
      !Number.isSafeInteger(p.completed) ||
      p.completed! < 0 ||
      !Number.isSafeInteger(p.total) ||
      p.total! < 0 ||
      (p.total! > 0 && p.completed! > p.total!) ||
      (p.completed === 0 && p.total === 0)
    )
      return;
    const previous = this.counters.get(p.stage);
    if (
      previous &&
      (p.completed! < previous.completed || p.unit !== previous.unit)
    ) {
      // A resumed/restarted pass invalidates later observations from the old attempt.
      let remove = false;
      for (const key of this.counters.keys()) {
        if (key === p.stage) remove = true;
        if (remove) this.counters.delete(key);
      }
    }
    this.counters.set(p.stage, {
      stage: p.stage,
      message: p.message ?? p.stage,
      completed: p.completed!,
      total: p.total!,
      unit: p.unit,
    });
    if (this.counters.size > 64)
      this.counters.delete(this.counters.keys().next().value!);
  }
  previous(currentStage?: string): CompilerPassCounter[] {
    return [...this.counters.values()]
      .filter((p) => p.stage !== currentStage)
      .map((p) => ({ ...p }));
  }
}
