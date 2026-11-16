import { estimatePreparation, type EstimateSource } from "./estimate";
import type { PackageSelection } from "./selection";
export const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
/** Shared host policy: source downloads, compiler guards and UI use one reserve. */
export const DISK_RESERVE = 10 * GIB;
export const BUILD_STOP_MARGIN = 2 * GIB;
export const BUILD_DISK_FLOOR = DISK_RESERVE + BUILD_STOP_MARGIN;
const CACHED_SCRATCH_ALLOWANCE = 64 * GIB;
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
export function cachedBuildSpace(
  maxBytes: number,
  partitioned = false,
  reusedScratchBytes = 0,
) {
  // Minimum admission allowance; actual expansion is checked throughout every stage.
  if (partitioned)
    return (
      DISK_RESERVE +
      Math.max(0, CACHED_SCRATCH_ALLOWANCE - Math.max(0, reusedScratchBytes)) +
      maxBytes
    );
  return DISK_RESERVE + 4 * GIB + maxBytes * 6;
}

/** Restart headroom, not a whole-build size prediction. Only a stopped partitioned
 * build with a saved extraction qualifies. Its worker verifies checkpoints and
 * monitors free space throughout; maxBytes still caps every output archive. */
export function cachedResumeSpace(
  maxBytes: number,
  partitioned: boolean,
  extractedBytes: number,
) {
  return partitioned && extractedBytes > 0
    ? BUILD_DISK_FLOOR + Math.min(maxBytes, CACHED_SCRATCH_ALLOWANCE)
    : cachedBuildSpace(maxBytes, partitioned);
}

/** Host UI has no user-chosen output ceiling; explicit CLI/API ceilings still work. */
export const NO_SIZE_LIMIT = Number.MAX_SAFE_INTEGER;
/** Admission estimate only. The output ceiling must never be treated as predicted bytes. */
export function hostPreparationSpace(
  maxBytes: number,
  input: {
    selection?: PackageSelection;
    estimateSource?: EstimateSource;
    sourceBytes?: number;
    atlasBytes?: number;
    cached?: boolean;
    partitioned?: boolean;
    resume?: boolean;
    extractedBytes?: number;
  },
) {
  if (maxBytes !== NO_SIZE_LIMIT)
    return input.cached
      ? input.resume
        ? cachedResumeSpace(
            maxBytes,
            !!input.partitioned,
            input.extractedBytes ?? 0,
          )
        : cachedBuildSpace(maxBytes, !!input.partitioned)
      : preparationSpace(maxBytes, input.sourceBytes);
  if (input.selection && input.estimateSource && !input.resume) {
    const estimate = estimatePreparation(input.selection, input.estimateSource);
    return (
      BUILD_DISK_FLOOR +
      estimate.downloadBytes +
      estimate.output.high +
      estimate.temporary.high
    );
  }
  if (input.cached)
    return (
      BUILD_DISK_FLOOR +
      (input.partitioned
        ? Math.max(
            4 * GIB,
            CACHED_SCRATCH_ALLOWANCE - (input.extractedBytes ?? 0),
          )
        : 4 * GIB)
    );
  if (input.sourceBytes !== undefined)
    return BUILD_DISK_FLOOR + 4 * GIB + input.sourceBytes * 3;
  return 64 * MIB + (input.atlasBytes ?? 0) * 2;
}
export interface StorageWarningInfo {
  estimatedBytes: number;
  availableBytes: number;
}
export class StorageWarning extends Error {
  readonly storageWarning: StorageWarningInfo;
  constructor(estimatedBytes: number, availableBytes: number) {
    super(
      `This job might exceed available disk space: ${(estimatedBytes / GIB).toFixed(2)} GiB planning allowance, ${(availableBytes / GIB).toFixed(2)} GiB free. You can start anyway; runtime free-space checks still apply.`,
    );
    this.storageWarning = { estimatedBytes, availableBytes };
  }
}
export function checkStorageEstimate(
  estimated: number,
  available: number,
  override: unknown = false,
) {
  if (typeof override !== "boolean")
    throw new Error("Invalid storage override");
  if (estimated > available && !override)
    throw new StorageWarning(estimated, available);
}
