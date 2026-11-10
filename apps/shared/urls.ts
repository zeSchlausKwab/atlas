/** Deployment addresses are explicit; a catalog's relative URLs belong to its server. */
export function serverAddress(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP(S) server address without credentials, query or fragment.",
    );
  return url.href.replace(/\/+$/, "") + "/";
}
export function clientLink(
  client: string,
  server: string,
  selection: { map?: string; maps?: string[] } = {},
) {
  const url = new URL(client);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid client URL");
  for (const key of [
    "map",
    "maps",
    "source",
    "api",
    "viewRecipe",
    "publisher",
    "relay",
  ])
    url.searchParams.delete(key);
  url.searchParams.set("server", serverAddress(server));
  if (selection.map) url.searchParams.set("map", selection.map);
  if (selection.maps) url.searchParams.set("maps", selection.maps.join(","));
  url.hash = selection.map ? "" : "tab=composer";
  return url.href;
}
