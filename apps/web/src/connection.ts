import { serverAddress, clientLink } from "../../shared/urls";
import { httpUrl } from "../../../packages/format/src/catalog";
export async function clientConnection() {
  const query = new URLSearchParams(location.search);
  const response = await fetch("/client-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Client configuration is unavailable");
  const config = await response.json();
  const server = serverAddress(query.get("server") ?? config.serverUrl);
  const endpoint = (path: string) =>
    new URL(path.replace(/^\//, ""), server).href;
  const input = document.getElementById("server-address") as HTMLInputElement;
  input.value = server;
  (document.getElementById("compose-all") as HTMLAnchorElement).href =
    clientLink(location.href, server);
  document.getElementById("server-status")!.textContent =
    `Map data and server tools: ${new URL(server).host}`;
  (document.getElementById("host-console") as HTMLAnchorElement).href =
    endpoint("host");
  document.getElementById("server-form")!.onsubmit = (event) => {
    event.preventDefault();
    try {
      const next = new URL(location.href);
      next.searchParams.set("server", serverAddress(input.value));
      for (const key of ["map", "maps", "source", "api"])
        next.searchParams.delete(key);
      next.hash = "tab=composer";
      location.assign(next.href);
    } catch (error) {
      document.getElementById("server-status")!.textContent = String(error);
    }
  };
  return {
    server,
    catalog: endpoint("catalog"),
    endpoint,
    source: query.has("source") ? httpUrl(query.get("source")!) : undefined,
    api: query.has("api") ? httpUrl(query.get("api")!) : undefined,
  };
}
/** A foreign source opens in this client, never at the server's root. */
export function sourceLink(source: string, api: string) {
  const url = new URL(location.href);
  for (const key of ["map", "maps"]) url.searchParams.delete(key);
  url.searchParams.set("source", httpUrl(source));
  url.searchParams.set("api", httpUrl(api));
  url.hash = "";
  return url.href;
}
