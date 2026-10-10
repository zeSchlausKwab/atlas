import { BlockList, isIP } from "node:net";

export type AdminAccess = (request: Request, remoteAddress?: string) => boolean;
/** Trust the socket peer and an exact host origin; never forwarding headers. */
export function adminAccess(origins = "", subnets = ""): AdminAccess {
  const allowed = new Set(
    origins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const networks = new BlockList();
  const ranges = subnets
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!!allowed.size !== !!ranges.length)
    throw new Error(
      "Set both ATLAS_ADMIN_ORIGINS and ATLAS_ADMIN_SUBNETS for LAN administration",
    );
  for (const origin of allowed) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
      throw new Error("Admin origins must be exact HTTP(S) origins");
  }
  for (const range of ranges) {
    const [address, prefix, extra] = range.split("/");
    if (
      extra ||
      !address ||
      isIP(address) !== 4 ||
      !/^\d+$/.test(prefix ?? "") ||
      Number(prefix) < 1 ||
      Number(prefix) > 32
    )
      throw new Error(
        "Admin subnets must be explicit IPv4 CIDRs (prefix 1–32)",
      );
    networks.addSubnet(address, Number(prefix), "ipv4");
  }
  return (request, remoteAddress) => {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return false;
    const peer = remoteAddress?.replace(/^::ffff:/, "") ?? "";
    if (
      ["127.0.0.1", "::1"].includes(peer) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return true;
    return (
      allowed.has(url.origin) &&
      isIP(peer) === 4 &&
      networks.check(peer, "ipv4")
    );
  };
}
export const ADMIN_DENIED =
  "Administration is not enabled for this address. Use the SSH tunnel, or configure this server’s trusted LAN origins and subnets.";
