import type { PackageSelection } from "../../provisioning/src/selection";
export const PARTITIONED_VERSION = 6;
export interface PartitionedState {
  identity: string;
  completed: Record<string, { size: number; sha256: string }>;
}
export function partitionedIdentity(
  inputHash: string,
  selection: PackageSelection,
  version = PARTITIONED_VERSION,
) {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ version, inputHash, selection }))
    .digest("hex");
}
/** v6 retains administrative areas; older source/semantic stages must be rebuilt. Transport and display remain reusable. */
export function reconcilePartitionedState(
  old: PartitionedState | undefined,
  inputHash: string,
  selection: PackageSelection,
) {
  const identity = partitionedIdentity(inputHash, selection);
  if (!old)
    return {
      state: { identity, completed: {} } as PartitionedState,
      migrated: false,
    };
  if (old.identity === identity) return { state: old, migrated: false };
  // Matching the *entire* old fingerprint is mandatory: no bypass for another source or recipe.
  if (
    ![4, 5].some(
      (version) =>
        old.identity === partitionedIdentity(inputHash, selection, version),
    )
  )
    throw new Error(
      "Partitioned checkpoints belong to another source, recipe or compiler",
    );
  const completed: PartitionedState["completed"] = {};
  for (const name of ["transport.atlas", "display.atlas"])
    if (old.completed[name]) completed[name] = old.completed[name];
  // Each retained artifact still undergoes the normal size + SHA-256 check before reuse.
  return { state: { identity, completed }, migrated: true };
}
