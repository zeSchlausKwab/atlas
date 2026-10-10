import { resolve } from "node:path";
/** Serve only an app's built public directory. Never fall back to source or map data. */
export function staticFiles(directory: string) {
  const root = resolve(directory);
  return async (request: Request, path = new URL(request.url).pathname) => {
    if (!["GET", "HEAD"].includes(request.method)) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    if (
      decoded
        .split("/")
        .some((part) => part.startsWith(".") || part.includes("\\"))
    )
      return undefined;
    const filePath = resolve(root, "." + decoded);
    if (!filePath.startsWith(root + "/")) return undefined;
    const file = Bun.file(filePath);
    if (!(await file.exists())) return undefined;
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
    });
  };
}
