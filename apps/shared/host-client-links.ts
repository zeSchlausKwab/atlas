import { clientLink } from "./urls";

export interface HostClientConfig {
  clientUrl: string;
  discovery?: { pubkey: string; relays: string[] };
  delivery?: { fips: boolean; http: boolean };
}

/** Host inspection prefers direct HTTP when enabled; mesh launches remain explicit. */
export function hostClientLinks(
  config: HostClientConfig,
  server: string,
  selection: { map?: string; maps?: string[] } = {},
) {
  const links: { transport: "http" | "fips"; label: string; url: string }[] =
    [];
  const base = new URL(clientLink(config.clientUrl, server, selection));
  // Do not inherit a previous launch's transport, fallback permission or saved view.
  for (const key of ["transport", "httpFallback", "view"])
    base.searchParams.delete(key);
  if (config.delivery?.http ?? true) {
    const url = new URL(base);
    url.searchParams.set("transport", "http");
    links.push({
      transport: "http",
      label: "Inspect over HTTP",
      url: url.href,
    });
  }
  if (config.delivery?.fips && config.discovery?.relays.length) {
    const url = new URL(base);
    url.searchParams.delete("server");
    url.searchParams.set("transport", "fips");
    url.searchParams.set("publisher", config.discovery.pubkey);
    for (const relay of config.discovery.relays)
      url.searchParams.append("relay", relay);
    links.push({ transport: "fips", label: "Open over FIPS", url: url.href });
  }
  return links;
}
