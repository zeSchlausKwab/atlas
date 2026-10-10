import { adminAccess, ADMIN_DENIED, type AdminAccess } from "./admin-access";
import { rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OperationHost } from "../../packages/operations/src/host";
export async function hostPolicy(
  host: OperationHost,
  path: string,
  onChange = () => {},
  access: AdminAccess = adminAccess(),
) {
  const registry = host.engine.registry;
  if (await Bun.file(path).exists()) {
    const stored = await Bun.file(path).json();
    if (
      !Array.isArray(stored.disabled) ||
      !stored.disabled.every((id: unknown) => typeof id === "string")
    )
      throw new Error("Invalid host policy file");
    for (const id of stored.disabled)
      if (registry.describe(id)) registry.setEnabled(id, false);
  }
  let tail = Promise.resolve();
  return async (request: Request, remoteAddress: string | undefined) => {
    const url = new URL(request.url);
    if (!access(request, remoteAddress))
      return new Response(ADMIN_DENIED, { status: 403 });
    if (request.method === "GET")
      return Response.json(host.catalog(), {
        headers: { "Cache-Control": "no-store" },
      });
    if (request.method !== "POST")
      return new Response("Use POST", { status: 405 });
    if (
      request.headers.get("Origin") !== url.origin ||
      request.headers.get("Content-Type") !== "application/json"
    )
      return new Response("Same-origin JSON request required", { status: 403 });
    let body: any;
    try {
      body = await request.json();
      if (
        typeof body.id !== "string" ||
        typeof body.enabled !== "boolean" ||
        registry.describe(body.id)?.implementation !== body.implementation
      )
        throw new Error();
    } catch {
      return new Response("Invalid or stale policy update", { status: 400 });
    }
    const work = tail.then(async () => {
      const disabled = new Set(registry.disabledIds);
      body.enabled ? disabled.delete(body.id) : disabled.add(body.id);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(
        `${path}.tmp`,
        JSON.stringify({ disabled: [...disabled].sort() }, null, 2),
      );
      await rename(`${path}.tmp`, path);
      registry.setEnabled(body.id, body.enabled);
      onChange();
    });
    tail = work.catch(() => {});
    try {
      await work;
      return Response.json(host.catalog());
    } catch {
      return new Response("Could not persist host policy", { status: 500 });
    }
  };
}
