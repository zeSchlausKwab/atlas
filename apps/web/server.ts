import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticFiles } from "../shared/static";
import { serverAddress } from "../shared/urls";
export function clientHandler(directory: string, serverUrl?: string) {
  const assets = staticFiles(directory);
  const config = serverUrl
    ? { serverUrl: serverAddress(serverUrl) }
    : undefined;
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return Response.json({ ok: true, service: "atlas-client" });
    if (
      path === "/client-config.json" &&
      config &&
      ["GET", "HEAD"].includes(request.method)
    )
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify(config),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    return (
      (await assets(
        request,
        path === "/"
          ? "/index.html"
          : path === "/compose"
            ? "/compose.html"
            : path,
      )) ?? new Response("Not found", { status: 404 })
    );
  };
}
if (import.meta.main) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = resolve(root, process.env.ATLAS_CLIENT_DIR ?? "dist/client");
  if (!(await Bun.file(resolve(dir, "index.html")).exists()))
    throw new Error("Build the client first: bun run build:client");
  const server = Bun.serve({
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 5173),
    fetch: clientHandler(dir, process.env.ATLAS_SERVER_URL),
  });
  console.log(
    `ATLAS client → ${server.url} (static assets only; no map files or APIs)`,
  );
}
