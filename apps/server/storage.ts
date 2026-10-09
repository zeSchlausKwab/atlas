import { statfs } from "node:fs/promises";
import type { StorageInfo } from "../../packages/provisioning/src/capacity";
/** Space available to this process on the filesystem holding prepared maps. */
export async function readStorage(directory: string): Promise<StorageInfo> {
  const disk = await statfs(directory);
  return {
    availableBytes: disk.bavail * disk.bsize,
    totalBytes: disk.blocks * disk.bsize,
    checkedAt: new Date().toISOString(),
  };
}
