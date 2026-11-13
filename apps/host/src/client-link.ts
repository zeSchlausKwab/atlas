import {
  hostClientLinks,
  type HostClientConfig,
} from "../../shared/host-client-links";
const response = await fetch("/host-config.json", { cache: "no-store" });
if (!response.ok) throw new Error("Host configuration unavailable");
const config = (await response.json()) as HostClientConfig;
const listeners = new Set<() => void>();
export function onClientDeliveryChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function updateClientDiscovery(
  discovery: { pubkey: string; relays: string[] },
  fips: boolean,
  http: boolean,
) {
  const delivery = { fips, http };
  if (
    JSON.stringify([config.discovery, config.delivery]) ===
    JSON.stringify([discovery, delivery])
  )
    return;
  config.discovery = discovery;
  config.delivery = delivery;
  for (const listener of listeners) listener();
}
export const clientLinks = (
  selection: { map?: string; maps?: string[] } = {},
) => hostClientLinks(config, location.origin, selection);
