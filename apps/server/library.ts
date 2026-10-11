import type { Preparations } from "./preparations";
import { PackageSource } from "./package-source";
import { servePackage } from "./ranges";
import { AtlasReader } from "../../packages/format/src/reader";
import type { AtlasEngine } from "../../packages/operations/src/index";
import { OperationHost } from "../../packages/operations/src/host";
import { createApiHandler } from "./api";
/** A small bounded pool. Range downloads stream independently of compute engines. */
export class HostedLibrary {
  private files = new Map<string, Promise<PackageSource>>();
  private engines = new Map<
    string,
    {
      busy: number;
      value: Promise<{
        engine: AtlasEngine;
        api: ReturnType<typeof createApiHandler>;
      }>;
    }
  >();
  constructor(
    private preparations: Preparations,
    private createEngine: (reader: AtlasReader) => AtlasEngine,
  ) {
    preparations.beforeDelete = (id) => this.remove(id);
  }
  async remove(id: string) {
    const entry = this.engines.get(id),
      file = this.files.get(id);
    this.engines.delete(id);
    this.files.delete(id);
    try {
      if (entry) {
        const ready = await entry.value.catch(() => undefined);
        ready?.engine.destroy();
        ready?.engine.reader.dispose();
      }
    } finally {
      if (file) await (await file.catch(() => undefined))?.close();
    }
  }
  private source(id: string) {
    let f = this.files.get(id);
    if (!f) {
      f = PackageSource.open(this.preparations.path(id));
      this.files.set(id, f);
      f.catch(() => this.files.delete(id));
    }
    return f;
  }
  async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname,
      match = path.match(/^\/maps\/([a-f0-9-]{36})(\.atlas|\/api\/[^/]+)$/);
    if (!match) return;
    const id = match[1]!;
    if (this.preparations.jobs.get(id)?.state !== "ready")
      return new Response("Map not found", { status: 404 });
    try {
      const source = await this.source(id);
      if (this.preparations.jobs.get(id)?.state !== "ready")
        return new Response("Map not found", { status: 404 });
      await source.assertUnchanged();
      if (match[2] === ".atlas")
        return servePackage(request, source, source.etag);
      let entry = this.engines.get(id);
      if (!entry) {
        if (this.engines.size >= 4) {
          const idle = [...this.engines].find(([, v]) => !v.busy);
          if (!idle)
            return new Response("Compute pool busy; retry shortly.", {
              status: 429,
            });
          this.engines.delete(idle[0]);
          void idle[1].value
            .then((old) => {
              old.engine.destroy();
              old.engine.reader.dispose();
            })
            .catch(console.error);
        }
        entry = {
          busy: 0,
          value: (async () => {
            const engine = this.createEngine(
              await new AtlasReader(source).open(),
            );
            return {
              engine,
              api: createApiHandler(engine, new OperationHost(engine)),
            };
          })(),
        };
        this.engines.set(id, entry);
      }
      entry.busy++;
      try {
        return await (await entry.value).api(request);
      } finally {
        entry.busy--;
      }
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 503 });
    }
  }
  async close() {
    for (const entry of this.engines.values()) {
      const { engine } = await entry.value;
      engine.destroy();
      engine.reader.dispose();
    }
    for (const file of this.files.values()) await (await file).close();
  }
}
