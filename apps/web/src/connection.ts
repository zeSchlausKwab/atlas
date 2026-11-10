import { serverAddress, clientLink } from "../../shared/urls";
import { httpUrl } from "../../../packages/format/src/catalog";
import { relayUrl } from "../../../packages/hashtree/src/discovery";
import { deliveryChoice } from "./transport";
export interface DiscoveryConnection {
  publisher: string;
  relays: string[];
}
export function discoveryConnection(
  query: URLSearchParams,
  config?: { discovery?: DiscoveryConnection },
): DiscoveryConnection | undefined {
  const publisher = query.get("publisher") ?? config?.discovery?.publisher;
  const relays = query.has("relay")
    ? query.getAll("relay")
    : (config?.discovery?.relays ?? []);
  if (!publisher && !relays.length) return;
  if (!publisher || !/^[a-f0-9]{64}$/.test(publisher))
    throw new Error("Discovery needs the publisher’s 64-character public key.");
  if (!relays.length || relays.length > 8)
    throw new Error("Discovery needs 1–8 Nostr relay addresses.");
  return { publisher, relays: [...new Set(relays.map(relayUrl))] };
}
export async function clientConnection() {
  const query = new URLSearchParams(location.search);
  let config: {
    serverUrl?: string;
    discovery?: DiscoveryConnection;
    transport?: string;
  } = {};
  // A signed-discovery link is self-contained: never contact a map HTTP host.
  if (!query.has("publisher") && !query.has("relay")) {
    const response = await fetch("/client-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Client configuration is unavailable");
    config = await response.json();
  }
  const discovery = discoveryConnection(query, config);
  const rawServer = query.get("server") ?? config.serverUrl;
  const server = rawServer ? serverAddress(rawServer) : undefined;
  const endpoint = (path: string) => {
    if (!server)
      throw new Error("No HTTP map host is configured. Use signed discovery.");
    return new URL(path.replace(/^\//, ""), server).href;
  };
  const input = document.getElementById("server-address") as HTMLInputElement;
  input.value = server ?? "";
  const home = document.querySelector<HTMLAnchorElement>(
    '[aria-label="Atlas home"]',
  )!;
  const compose = document.getElementById("compose-all") as HTMLAnchorElement;
  home.href = compose.href =
    server && !discovery ? clientLink(location.href, server) : location.href;
  document.getElementById("server-status")!.textContent = discovery
    ? `Signed discovery · publisher ${discovery.publisher.slice(0, 12)}… · ${discovery.relays.length} relay${discovery.relays.length === 1 ? "" : "s"}`
    : server
      ? `Discovery bootstrap: ${new URL(server).host}`
      : "Choose a publisher and relay to discover maps.";
  const hostConsole = document.getElementById(
    "host-console",
  ) as HTMLAnchorElement;
  hostConsole.hidden = !server;
  if (server) hostConsole.href = endpoint("host");
  document.getElementById("server-form")!.onsubmit = (event) => {
    event.preventDefault();
    try {
      const next = new URL(location.href);
      next.searchParams.set("server", serverAddress(input.value));
      for (const key of [
        "map",
        "maps",
        "source",
        "api",
        "viewRecipe",
        "publisher",
        "relay",
      ])
        next.searchParams.delete(key);
      next.hash = "tab=composer";
      location.assign(next.href);
    } catch (error) {
      document.getElementById("server-status")!.textContent = String(error);
    }
  };
  const choice = deliveryChoice(query, config.transport);
  const transport = document.getElementById(
    "composition-transport",
  ) as HTMLSelectElement;
  const fallback = document.getElementById(
    "composition-http-fallback",
  ) as HTMLInputElement;
  transport.value = choice.transport;
  fallback.checked = choice.allowHttpFallback;
  fallback.disabled = choice.transport === "http";
  const changeDelivery = () => {
    const next = new URL(location.href);
    next.searchParams.set("transport", transport.value);
    if (fallback.checked && transport.value === "fips")
      next.searchParams.set("httpFallback", "1");
    else next.searchParams.delete("httpFallback");
    location.assign(next.href);
  };
  transport.onchange = fallback.onchange = changeDelivery;
  return {
    server,
    discovery,
    delivery: choice,
    catalog: server && !discovery ? endpoint("catalog") : undefined,
    endpoint,
    source: query.has("source") ? httpUrl(query.get("source")!) : undefined,
    api: query.has("api") ? httpUrl(query.get("api")!) : undefined,
  };
}
/** Pinned map links retain relay discovery; htree identities are never fetched as URLs. */
export function sourceLink(source: string, api?: string, mapId?: string) {
  if (source.startsWith("htree:")) {
    const next = new URL(location.href);
    next.searchParams.set("maps", mapId ?? source.slice("htree://".length));
    for (const key of ["map", "source", "api", "viewRecipe"])
      next.searchParams.delete(key);
    next.hash = "tab=composer";
    return next.href;
  }
  const input = new URL(httpUrl(source));
  const id =
    mapId ?? input.pathname.match(/\/maps\/(demo|[a-f0-9-]{36})\.atlas$/)?.[1];
  if (!id) throw new Error("Map link requires a hosted dataset identity");
  return clientLink(
    location.href,
    api ? new URL(httpUrl(api)).origin : input.origin,
    { maps: [id] },
  );
}
