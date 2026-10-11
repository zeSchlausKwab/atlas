import { verifiedSource, verifiedSources } from "./verified-sources";
import {
  cachedBuildSpace,
  planCachedBuild,
  type VerifiedBuildSource,
} from "../../packages/provisioning/src/cached-build";
import { adminAccess, ADMIN_DENIED, type AdminAccess } from "./admin-access";
import { preparationSpace } from "../../packages/provisioning/src/capacity";
import { readStorage } from "./storage";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Manifest } from "../../packages/format/src/index";
import {
  availability,
  validateSelection,
  validateSelectionScope,
  type PackageSelection,
  type PreparationProgress,
} from "../../packages/provisioning/src/selection";
import {
  WORLD_SOURCE,
  planMatches,
  type PbfPlan,
} from "../../packages/provisioning/src/global-source";
import { validateImportSize } from "../../packages/provisioning/src/import-pbf";
import { PbfSources } from "./pbf-sources";
export interface PreparationJob {
  id: string;
  name: string;
  createdAt: string;
  state: "running" | "cancelling" | "cancelled" | "failed" | "ready";
  selection: PackageSelection;
  sourcePlan?: PbfPlan;
  cachedSource?: VerifiedBuildSource;
  progress: PreparationProgress;
  error?: string;
  size?: number;
  manifest?: Manifest;
}
export class Preparations {
  readonly sources = new PbfSources();
  readonly jobs = new Map<string, PreparationJob>();
  private worker?: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private active?: string;
  private writes = Promise.resolve();
  private settling?: Promise<void>;
  private constructor(
    readonly directory: string,
    readonly sourcePath: string,
    readonly source: Manifest,
    private readonly access: AdminAccess,
  ) {}
  static async open(
    directory: string,
    sourcePath: string,
    source: Manifest,
    access: AdminAccess = adminAccess(),
  ) {
    const manager = new Preparations(directory, sourcePath, source, access);
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const job = (await Bun.file(
        resolve(directory, name),
      ).json()) as PreparationJob;
      if (name !== `${job.id}.json`)
        throw new Error("Invalid preparation record");
      manager.jobs.set(job.id, job);
      if (job.state === "running" || job.state === "cancelling") {
        job.state = "failed";
        job.error = job.cachedSource
          ? "Server stopped. Resume to reuse completed compiler stages."
          : "Server stopped during preparation. Create the excerpt again.";
        await manager.cleanup(job.id, !!job.cachedSource);
        await manager.persist(job);
      }
      if (
        job.state === "ready" &&
        !(await Bun.file(manager.path(job.id)).exists())
      ) {
        job.state = "failed";
        job.error = "Prepared file is missing from disk.";
        await manager.persist(job);
      }
    }
    return manager;
  }
  path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid map ID");
    return resolve(this.directory, `${id}.atlas`);
  }
  private persist(job: PreparationJob) {
    const body = JSON.stringify(job),
      path = resolve(this.directory, `${job.id}.json`);
    const work = this.writes.then(async () => {
      await Bun.write(path + ".tmp", body);
      await rename(path + ".tmp", path);
    });
    this.writes = work.catch(console.error);
    return work;
  }
  private async cleanup(id: string, keepWork = false) {
    if (!keepWork)
      await rm(resolve(this.directory, `${id}.work`), {
        recursive: true,
        force: true,
      });
    for (const suffix of ["", ".part", ".payload.part"])
      await rm(this.path(id) + suffix, { force: true });
  }
  get sourceDirectory() {
    return resolve(this.directory, "../sources");
  }
  async resume(id: string) {
    const job = this.jobs.get(id);
    if (!job?.cachedSource || !["failed", "cancelled"].includes(job.state))
      throw new Error(
        "Only stopped cached-source preparations can be resumed.",
      );
    return this.create(
      { ...job.selection, cachedSourceId: job.cachedSource.id },
      job,
    );
  }
  async create(value: unknown, previous?: PreparationJob) {
    const extra = value as {
      sourcePlanId?: string;
      cachedSourceId?: string;
      maxSourceBytes?: number;
    } | null;
    const plan = extra?.sourcePlanId
      ? this.sources.get(extra.sourcePlanId)
      : undefined;
    const cached = extra?.cachedSourceId
      ? await verifiedSource(this.sourceDirectory, extra.cachedSourceId)
      : undefined;
    if (cached && extra?.sourcePlanId)
      throw new Error("Choose one PBF source.");
    if (cached) {
      validateSelectionScope(value, WORLD_SOURCE);
      planCachedBuild(value);
      if (
        previous?.cachedSource &&
        (previous.cachedSource.sha256 !== cached.sha256 ||
          previous.cachedSource.mtimeMs !== cached.mtimeMs)
      )
        throw new Error("Cached PBF changed since this build started.");
      if (!Bun.which("osmium") || !Bun.which("cargo"))
        throw new Error(
          "PBF preparation requires Osmium and Cargo on the server.",
        );
    } else if (plan) {
      validateSelectionScope(value, WORLD_SOURCE);
      if (!planMatches(plan, value, extra!.maxSourceBytes!))
        throw new Error(
          "Area, routing padding or source budget changed. Check the PBF source again.",
        );
      if (!Bun.which("osmium") || !Bun.which("cargo"))
        throw new Error(
          "PBF preparation requires Osmium and Cargo on the server.",
        );
      validateImportSize(plan, value);
    } else validateSelection(value, this.source);
    if (this.active)
      throw new Error(
        "Another preparation is running. Wait for it or cancel it first.",
      );
    const id = previous?.id ?? crypto.randomUUID();
    this.active = id;
    try {
      const disk = await readStorage(this.directory);
      const needed = cached
        ? cachedBuildSpace(
            value.maxBytes,
            !!planCachedBuild(value).partitioned,
            previous
              ? Bun.file(
                  resolve(this.directory, `${id}.work/extraction/area.osm.pbf`),
                ).size
              : 0,
          )
        : preparationSpace(value.maxBytes, plan?.bytes);
      if (disk.availableBytes < needed)
        throw new Error(
          `Not enough server disk space: ${(needed / 1073741824).toFixed(2)} GiB estimated, ${(disk.availableBytes / 1073741824).toFixed(2)} GiB available. Lower the output budget or select a smaller source.`,
        );
      const job: PreparationJob = {
        id,
        name: value.name.trim(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        state: "running",
        selection: structuredClone(value),
        sourcePlan: plan,
        cachedSource: cached,
        progress: {
          phase: "planning",
          message: cached
            ? "Opening verified cached PBF and saved compiler stages…"
            : plan
              ? `Preparing ${plan.region.name} from OSM PBF…`
              : "Opening the source snapshot…",
          completed: 0,
          total: 0,
          readBytes: 0,
          writtenBytes: 0,
        },
      };
      this.jobs.set(id, job);
      await this.persist(job);
      let worker: Bun.Subprocess<"ignore", "ignore", "pipe">;
      let finished = false;
      const finish = (data: {
        type: string;
        error?: string;
        size?: number;
        manifest?: Manifest;
      }) => {
        if (finished) return;
        finished = true;
        this.settling = (async () => {
          const cancelled =
            job.state === "cancelling" || data.type === "cancelled";
          job.state = cancelled
            ? "cancelled"
            : data.type === "ready"
              ? "ready"
              : "failed";
          job.error = cancelled ? "Preparation cancelled." : data.error;
          if (job.state === "ready") {
            job.size = data.size;
            job.manifest = data.manifest;
            job.progress.message = "Ready to serve and download.";
            job.progress.writtenBytes = data.size!;
          } else await this.cleanup(id, !!job.cachedSource);
          await this.persist(job);
        })()
          .catch((error) => {
            job.state = "failed";
            job.error = String(error);
            console.error(error);
          })
          .finally(() => {
            this.active = undefined;
            this.worker = undefined;
            worker.kill();
          });
      };
      worker = this.worker = Bun.spawn(
        [
          process.execPath,
          new URL("./preparation-worker.ts", import.meta.url).pathname,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          ipc(data: any) {
            if (data.type === "progress") {
              if (job.state !== "cancelling") {
                job.progress = data.progress;
                void manager.persist(job);
              }
            } else finish(data);
          },
        },
      );
      const manager = this;
      const stderr = new Response(worker.stderr).text();
      void worker.exited.then(async (code) => {
        if (!finished)
          finish({
            type: "failed",
            error: `Preparation process exited (${code}): ${(await stderr).slice(-2000)}`,
          });
      });
      worker.send({
        type: "start",
        source: this.sourcePath,
        output: this.path(id),
        selection: job.selection,
        sourcePlan: plan,
        cachedSource: cached,
      });
      return job;
    } catch (e) {
      this.worker?.kill();
      this.worker = undefined;
      const job = this.jobs.get(id);
      if (job) {
        job.state = "failed";
        job.error = String(e);
        await this.persist(job).catch(console.error);
      }
      this.active = undefined;
      throw e;
    }
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown preparation");
    if (job.state !== "running") return job;
    job.state = "cancelling";
    job.progress.message = job.cachedSource
      ? "Stopping; completed stages will be kept for resume…"
      : "Cancelling and removing partial files…";
    this.worker?.send({ type: "cancel" });
    await this.persist(job);
    return job;
  }
  catalog() {
    return [...this.jobs.values()]
      .filter((j) => j.state === "ready" && j.manifest)
      .map((j) => ({
        id: j.id,
        name: j.name,
        bytes: j.size,
        url: `/maps/${j.id}.atlas`,
        api: `/maps/${j.id}/api`,
        manifest: j.manifest,
      }));
  }
  async handle(request: Request, remoteAddress?: string) {
    const url = new URL(request.url),
      json = (value: unknown, status = 200) =>
        Response.json(value, {
          status,
          headers: { "Cache-Control": "no-store" },
        });
    if (!this.access(request, remoteAddress))
      return json({ error: ADMIN_DENIED }, 403);
    if (request.method === "GET" && url.pathname === "/admin/preparations")
      return json({
        storage: await readStorage(this.directory).catch(() => ({
          error: "Server disk information is unavailable.",
        })),
        source: this.source,
        available: availability(this.source),
        globalSource: {
          ...WORLD_SOURCE,
          ready: !!Bun.which("osmium") && !!Bun.which("cargo"),
        },
        cachedSources: await verifiedSources(this.sourceDirectory),
        jobs: [...this.jobs.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (
      request.headers.get("Origin") !== url.origin ||
      request.headers.get("Content-Type") !== "application/json"
    )
      return json({ error: "Same-origin JSON request required" }, 403);
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 16384)
        return json({ error: "Request too large" }, 413);
      const match = url.pathname.match(
        /^\/admin\/preparations\/([a-f0-9-]{36})\/(cancel|resume)$/,
      );
      if (match)
        return json(
          await (match[2] === "resume"
            ? this.resume(match[1]!)
            : this.cancel(match[1]!)),
        );
      if (url.pathname === "/admin/preparations/source-plan")
        return json(await this.sources.plan(JSON.parse(raw)));
      if (url.pathname !== "/admin/preparations")
        return json({ error: "Not found" }, 404);
      return json(await this.create(JSON.parse(raw)), 202);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  async close() {
    if (this.active) await this.cancel(this.active);
    await this.worker?.exited;
    if (this.settling) await this.settling;
    await this.writes;
  }
}
