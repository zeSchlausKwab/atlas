import { MIB } from "../../../packages/provisioning/src/capacity";
export function storageSize(bytes: number) {
  const units = ["MiB", "GiB", "TiB", "PiB"];
  let size = bytes / MIB,
    unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]}`;
}
