import { availableParallelism, totalmem } from "node:os";
/** Execution policy is not part of dataset identity: changing concurrency must preserve output. */
export function compilerWorkers(
  value: unknown = process.env.ATLAS_COMPILER_WORKERS,
): number {
  if (value === undefined)
    return Math.max(
      1,
      Math.min(
        6,
        availableParallelism() - 2,
        Math.floor(totalmem() / 1024 ** 3) - 2,
      ),
    );
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-8]$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 8)
    throw new Error("Compiler workers must be an integer from 1 to 8");
  return n;
}
