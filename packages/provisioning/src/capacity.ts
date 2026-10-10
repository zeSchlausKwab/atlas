export const MIB = 1024 * 1024;
/** Budgets are byte counts, not a format or product size cap. */
export function validBudget(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= MIB
  );
}
/** Capacity estimate, not a reservation or a guarantee about PBF expansion. */
export function preparationSpace(outputBytes: number, sourceBytes?: number) {
  return (
    64 * MIB +
    (sourceBytes === undefined
      ? outputBytes * 2
      : sourceBytes * 3 + Math.max(outputBytes, 64 * MIB) * 6)
  );
}
export function capacityBudget(
  availableBytes: number,
  kind: "output" | "source",
  global: boolean,
) {
  const multiplier = kind === "source" ? 3 : global ? 6 : 2;
  return Math.max(
    MIB,
    Math.floor(Math.max(0, availableBytes - 64 * MIB) / multiplier / MIB) * MIB,
  );
}
export interface StorageInfo {
  availableBytes: number;
  totalBytes: number;
  checkedAt: string;
}

/** Regional cached builds retain checkpoints and preserve the source-library reserve. */
export function cachedBuildSpace(maxBytes: number) {
  return 64 * 1024 ** 3 + maxBytes * 6;
}
