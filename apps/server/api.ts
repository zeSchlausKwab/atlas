import { validateTransport } from "../../packages/routing/src/index";
import {
  AtlasEngine,
  type Operation,
} from "../../packages/operations/src/index";
import { validPosition, normalize } from "../../packages/geocoding/src/model";
import { validateFeatureQuery } from "../../packages/features/src/index";
import { validatePolygon } from "../../packages/offline/src/geometry";
const OPERATIONS: Operation[] = [
  "route",
  "isochrone",
  "search",
  "reverse",
  "peak",
  "features",
  "offline",
];
/** Bounded, snapshot-pinned read-only operations. Serial execution gives meaningful source-byte metrics. */
export function createApiHandler(engine: AtlasEngine) {
  let pending = 0,
    tail: Promise<unknown> = Promise.resolve();
  return async (request: Request): Promise<Response> => {
    const operation = new URL(request.url).pathname.replace(
      "/api/",
      "",
    ) as Operation;
    const error = (message: string, status = 400) =>
      Response.json(
        { error: message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    if ((operation as string) === "capabilities" && request.method === "GET")
      return Response.json(engine.capabilities, {
        headers: {
          "Cache-Control": "no-store",
          "X-Atlas-Snapshot": engine.reader.index.manifest.snapshot,
        },
      });
    if (!OPERATIONS.includes(operation)) return error("Unknown operation", 404);
    if (request.method !== "POST")
      return error("Use POST for map operations", 405);
    let input: any;
    try {
      if (Number(request.headers.get("Content-Length")) > 16384)
        return error("Request too large", 413);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 16384)
        return error("Request too large", 413);
      const body = JSON.parse(raw);
      if (body.snapshot !== engine.reader.index.manifest.snapshot)
        return error(
          "Server snapshot differs from the open package. Reopen the map.",
          409,
        );
      input = body.input;
      if (
        operation === "route" &&
        (!validPosition(input?.start) || !validPosition(input?.end))
      )
        throw new Error("Invalid route endpoints");
      if (operation === "route" || operation === "isochrone")
        validateTransport(
          input?.profile ?? "walking",
          operation === "isochrone" ? (input?.bands ?? null) : undefined,
        );
      if (operation === "isochrone" && !validPosition(input?.start))
        throw new Error("Invalid isochrone origin");
      if (
        operation === "search" &&
        (typeof input?.query !== "string" ||
          normalize(input.query).length < 2 ||
          input.query.length > 120 ||
          (input.limit !== undefined &&
            (!Number.isInteger(input.limit) ||
              input.limit < 1 ||
              input.limit > 30)))
      )
        throw new Error("Invalid search query or limit");
      if (operation === "reverse" && !validPosition(input?.point))
        throw new Error("Invalid reverse coordinate");
      if (operation === "features") validateFeatureQuery(input);
      if (operation === "offline") {
        if (
          !input ||
          !Array.isArray(input.polygon) ||
          typeof input.name !== "string" ||
          input.name.length > 80 ||
          typeof input.routing !== "boolean" ||
          typeof input.search !== "boolean" ||
          (input.queries !== undefined && typeof input.queries !== "boolean")
        )
          throw new Error("Invalid offline selection");
        validatePolygon(input.polygon);
      }
    } catch (e) {
      return error(e instanceof Error ? e.message : "Invalid request");
    }
    if (pending >= 8) return error("Server is busy; retry shortly.", 429);
    pending++;
    const work = tail
      .then(async () => {
        const started = performance.now(),
          before = engine.reader.bytesRead;
        try {
          let result: unknown;
          switch (operation) {
            case "route":
              result = await engine.route(
                input.start,
                input.end,
                input.profile,
              );
              break;
            case "isochrone":
              result = await engine.isochrone(
                input.start,
                input.bands,
                input.profile,
              );
              break;
            case "search":
              result = await engine.search(input.query, input.limit);
              break;
            case "reverse":
              result = await engine.reverse(input.point);
              break;
            case "peak":
              result = await engine.peak();
              break;
            case "features":
              result = await engine.query(input);
              break;
            case "offline":
              result = await engine.offline(input);
              break;
          }
          const execution = {
            side: "server",
            operation,
            computeMs: performance.now() - started,
            sourceBytes: engine.reader.bytesRead - before,
            responseBytes: 0,
          };
          const headers = {
            "Cache-Control": "no-store",
            "X-Atlas-Snapshot": engine.reader.index.manifest.snapshot,
          };
          if (result instanceof Blob)
            return new Response(result, {
              headers: {
                ...headers,
                "Content-Type": "application/octet-stream",
                "Content-Disposition": 'attachment; filename="offline.atlas"',
                "X-Atlas-Compute-Ms": String(execution.computeMs),
                "X-Atlas-Source-Bytes": String(execution.sourceBytes),
              },
            });
          return Response.json({ result, execution }, { headers });
        } catch (e) {
          return error(
            e instanceof Error ? e.message : "Operation failed",
            422,
          );
        }
      })
      .finally(() => {
        pending--;
      });
    tail = work.catch(() => {});
    return work;
  };
}
