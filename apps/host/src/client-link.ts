import { clientLink } from "../../shared/urls";
const response = await fetch("/host-config.json", { cache: "no-store" });
if (!response.ok) throw new Error("Host configuration unavailable");
const config = (await response.json()) as {
  clientUrl: string;
  discovery?: { pubkey: string; relays: string[] };
  delivery?: { fips: boolean; http: boolean };
};
export function updateClientDiscovery(
  discovery: { pubkey: string; relays: string[] },
  fips: boolean,
) {
  config.discovery = discovery;
  config.delivery = { fips, http: config.delivery?.http ?? false };
}
export const openClient = (
  selection: { map?: string; maps?: string[] } = {},
) => {
  const link = new URL(
    clientLink(config.clientUrl, location.origin, selection),
  );
  if (config.delivery?.fips && config.discovery?.relays.length) {
    link.searchParams.delete("server");
    link.searchParams.set("publisher", config.discovery.pubkey);
    link.searchParams.delete("relay");
    for (const relay of config.discovery.relays)
      link.searchParams.append("relay", relay);
  }
  return link.href;
};
