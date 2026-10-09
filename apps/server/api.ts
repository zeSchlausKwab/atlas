import { AtlasEngine } from "../../packages/operations/src/index";
import { OperationHost } from "../../packages/operations/src/host";
import { OperationError } from "../../packages/operations/src/registry";
export function createApiHandler(
  engine: AtlasEngine,
  host = new OperationHost(engine),
) {
  return async (request: Request): Promise<Response> => {
    const operation = new URL(request.url).pathname.split("/api/").at(-1)!;
    const headers = {
      "Cache-Control": "no-store",
      "X-Atlas-Snapshot": engine.reader.index.manifest.snapshot,
    };
    const error = (message: string, status = 400) =>
      Response.json({ error: message }, { status, headers });
    if (operation === "capabilities" && request.method === "GET")
      return Response.json(host.catalog(), { headers });
    const descriptor = engine.registry.describe(operation);
    if (!descriptor) return error("Unknown operation", 404);
    if (request.method !== "POST")
      return error("Use POST for map operations", 405);
    let body: any;
    try {
      if (Number(request.headers.get("Content-Length")) > 16384)
        return error("Request too large", 413);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 16384)
        return error("Request too large", 413);
      body = JSON.parse(raw);
      // Keep v1 built-in URLs compatible. Extensions must pin their contract and code identity.
      body = {
        ...body,
        id: operation,
        version:
          body.version ??
          (descriptor.implementation === "atlas-core-1"
            ? descriptor.version
            : undefined),
        implementation:
          body.implementation ??
          (descriptor.implementation === "atlas-core-1"
            ? descriptor.implementation
            : undefined),
      };
      host.validate(body);
    } catch (e) {
      return error(
        e instanceof Error ? e.message : "Invalid request",
        e instanceof OperationError ? e.status : 400,
      );
    }
    try {
      const response = await host.invoke(body, request.signal);
      if (response.result instanceof Blob)
        return new Response(response.result, {
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="offline.atlas"',
            "X-Atlas-Compute-Ms": String(response.execution.computeMs),
            "X-Atlas-Source-Bytes": String(response.execution.sourceBytes),
          },
        });
      return Response.json(response, { headers });
    } catch (e) {
      return error(
        e instanceof Error ? e.message : "Operation failed",
        e instanceof OperationError
          ? e.status
          : request.signal.aborted
            ? 499
            : 422,
      );
    }
  };
}
