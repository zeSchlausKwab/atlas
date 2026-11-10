const STALE_MS = 30_000;
export function fipsStatusView(
  status: { state: string; updatedAt: string } | undefined,
  now = Date.now(),
) {
  if (!status) return { state: "unavailable", title: "Status unavailable" };
  if (status.state === "stopped")
    return { state: "stopped", title: "FIPS delivery is off" };
  if (status.state === "failed")
    return { state: "failed", title: "FIPS needs attention" };
  if (now - Date.parse(status.updatedAt) > STALE_MS)
    return { state: "stale", title: "Status is stale" };
  return status.state === "connected"
    ? { state: "connected", title: "Connected to the FIPS network" }
    : { state: "connecting", title: "Connecting to FIPS peers" };
}
