/** A single byte-range response. Multipart ranges are deliberately unsupported. */
export function parseRange(
  value: string,
  size: number,
): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start < size &&
    end >= start
    ? [start, end]
    : null;
}
export function servePackage(
  request: Request,
  file: Blob,
  etag: string,
): Response {
  const headers = new Headers({
    "Content-Type": "application/vnd.atlas",
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Match, If-Range",
    "Access-Control-Expose-Headers":
      "Content-Range, Content-Length, ETag, Accept-Ranges",
  });
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  const match = request.headers.get("if-match");
  if (
    match &&
    match !== "*" &&
    !match
      .split(",")
      .map((s) => s.trim())
      .includes(etag)
  )
    return new Response(null, { status: 412, headers });
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (range && request.method === "GET" && (!ifRange || ifRange === etag)) {
    const parsed = parseRange(range, file.size);
    if (!parsed) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    const [start, end] = parsed;
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(request.method === "HEAD" ? null : file, { headers });
}
