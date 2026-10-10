const allowedHeaders = [
  "content-type",
  "range",
  "if-match",
  "if-range",
  "if-none-match",
];
export function publicPath(path: string) {
  return (
    path === "/" ||
    path === "/health" ||
    path === "/catalog" ||
    path.startsWith("/api/") ||
    path.startsWith("/maps/")
  );
}
export function corsPolicy(value = "*") {
  if (value === "*") return new Set(["*"]);
  const origins = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of origins)
    if (new URL(origin).origin !== origin || !/^https?:/.test(origin))
      throw new Error("CORS origins must be exact HTTP(S) origins");
  return new Set(origins);
}
/** Public data/compute can be consumed cross-origin. Administration never can. */
export async function publicCors(
  request: Request,
  origins: Set<string>,
  handle: () => Promise<Response>,
) {
  const path = new URL(request.url).pathname;
  const origin = request.headers.get("Origin");
  if (!publicPath(path)) {
    if (origin && origin !== new URL(request.url).origin)
      return new Response("Same-origin administration required", {
        status: 403,
      });
    return handle();
  }
  if (
    origin &&
    origin !== new URL(request.url).origin &&
    !origins.has("*") &&
    !origins.has(origin)
  )
    return new Response("Origin not allowed", { status: 403 });
  const methods = path.endsWith(".atlas")
    ? "GET, HEAD, OPTIONS"
    : "GET, HEAD, POST, OPTIONS";
  let response: Response;
  if (request.method === "OPTIONS") {
    const method =
      request.headers.get("Access-Control-Request-Method") ?? "GET";
    const headers = (
      request.headers.get("Access-Control-Request-Headers") ?? ""
    )
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    response = new Response(null, {
      status:
        methods.split(", ").includes(method) &&
        headers.every((h) => allowedHeaders.includes(h))
          ? 204
          : 403,
    });
  } else {
    try {
      response = await handle();
    } catch (error) {
      console.error(error);
      response = Response.json(
        { error: "Server operation failed" },
        { status: 500 },
      );
    }
  }
  response.headers.set(
    "Access-Control-Allow-Origin",
    origins.has("*") ? "*" : (origin ?? new URL(request.url).origin),
  );
  response.headers.set("Access-Control-Allow-Methods", methods);
  response.headers.set(
    "Access-Control-Allow-Headers",
    allowedHeaders.join(", "),
  );
  response.headers.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, ETag, Accept-Ranges, X-Atlas-Snapshot, X-Atlas-Compute-Ms, X-Atlas-Source-Bytes, Content-Disposition",
  );
  response.headers.set("Access-Control-Max-Age", "600");
  response.headers.append("Vary", "Origin");
  return response;
}
