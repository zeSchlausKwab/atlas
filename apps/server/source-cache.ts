import { registerSourceLocation } from "./source-location";
import { PbfSources } from "./pbf-sources";
import { WORLD_SOURCE } from "../../packages/provisioning/src/global-source";
import { validateSelectionScope } from "../../packages/provisioning/src/selection";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { adminAccess, ADMIN_DENIED, type AdminAccess } from "./admin-access";
import {
  inspectSource,
  partialSize,
  SOURCE_RESERVE,
  type CachedSource,
  type SourceJob,
  type SourceKind,
} from "../../packages/provisioning/src/source-cache";
import { readStorage } from "./storage";
export class SourceCache {
  private regions = new PbfSources();
  private plans = new Map<string, CachedSource>();
  private children = new Map<string, Bun.Subprocess>();
  private busy = false;
  private queueTimer?: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(
    readonly directory: string,
    private access: AdminAccess = adminAccess(),
    private systemd = false,
  ) {}
  startQueue() {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(
      () => void this.drainQueue().catch(console.error),
      3000,
    );
    this.queueTimer.unref();
    void this.drainQueue().catch(console.error);
  }
  private async drainQueue() {
    if (this.busy || this.closing) return;
    const jobs = await this.list();
    for (const job of jobs) if (await this.running(job.id)) return;
    const next = jobs
      .filter((j) => j.state === "waiting")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!next || this.busy || this.closing) return;
    try {
      await this.launch(next);
    } catch (e) {
      await this.save({
        ...next,
        state: "failed",
        error: String(e),
        message: String(e),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  private async save(job: SourceJob) {
    const record = join(this.directory, job.id + ".json");
    await mkdir(this.directory, { recursive: true });
    await Bun.write(record + ".tmp", JSON.stringify(job));
    await rename(record + ".tmp", record);
  }
  async list(): Promise<SourceJob[]> {
    await mkdir(this.directory, { recursive: true });
    return Promise.all(
      (await readdir(this.directory))
        .filter((n) => /^[a-f0-9]{32}\.json$/.test(n))
        .map(async (n) => {
          const job = (await Bun.file(
            join(this.directory, n),
          ).json()) as SourceJob;
          if (
            job.state === "downloading" ||
            job.state === "retrying" ||
            job.state === "paused" ||
            job.state === "failed"
          )
            job.completed = await partialSize(
              join(this.directory, job.id + ".osm.pbf.part"),
            );
          // An unexpected exit is a failure, not an intentional pause. Keep the partial resumable.
          if (
            ["queued", "downloading", "retrying", "verifying"].includes(
              job.state,
            ) &&
            Date.now() - Date.parse(job.updatedAt) > 15000
          ) {
            const worker = await this.workerStatus(job.id);
            if (!worker.active) {
              // Do not overwrite a ready/paused record published while status was queried.
              const latest = (await Bun.file(
                join(this.directory, n),
              ).json()) as SourceJob;
              if (
                latest.updatedAt !== job.updatedAt ||
                latest.state !== job.state
              )
                return latest;
              job.state = "failed";
              job.error =
                worker.result === "oom-kill"
                  ? "Download worker exceeded its memory limit and was killed. Saved bytes are intact; resume the download."
                  : `Download worker stopped unexpectedly${worker.result && worker.result !== "success" ? ` (${worker.result})` : ""}. Saved bytes are intact; resume the download.`;
              job.message = job.error;
            }
          }
          return job;
        }),
    );
  }
  private async workerStatus(id: string) {
    if (!this.systemd) return { active: this.children.has(id), result: "" };
    const process = Bun.spawn(
      [
        "systemctl",
        "--user",
        "show",
        `atlas-source-${id}.service`,
        "--property=ActiveState",
        "--property=Result",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(process.stdout).text();
    await process.exited;
    const values = Object.fromEntries(
      output
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    return {
      active: ["active", "activating", "deactivating"].includes(
        values.ActiveState ?? "",
      ),
      result: values.Result ?? "",
    };
  }
  private async running(id: string) {
    return (await this.workerStatus(id)).active;
  }
  private async launch(source: CachedSource) {
    if (this.busy) throw new Error("A source action is already in progress");
    this.busy = true;
    try {
      const jobs = await this.list();
      const existing = jobs.find((j) => j.id === source.id);
      if (
        (source as SourceJob).state === "waiting" &&
        existing?.state !== "waiting"
      )
        return existing;
      if (
        existing?.state === "ready" &&
        (await Bun.file(join(this.directory, source.id + ".osm.pbf")).exists())
      )
        return existing;
      for (const j of jobs)
        if (await this.running(j.id)) {
          if (j.id === source.id) return j;
          const queued: SourceJob = {
            ...source,
            state: "waiting",
            completed: await partialSize(
              join(this.directory, source.id + ".osm.pbf.part"),
            ),
            updatedAt:
              existing?.state === "waiting"
                ? existing.updatedAt
                : new Date().toISOString(),
            message: "Queued; starts after the active source download",
          };
          await this.save(queued);
          this.startQueue();
          return queued;
        }
      const offset = await partialSize(
        join(this.directory, source.id + ".osm.pbf.part"),
      );
      const disk = await readStorage(this.directory);
      if (
        disk.availableBytes <
        Math.max(0, source.bytes - offset) + SOURCE_RESERVE
      )
        throw new Error(
          `Not enough disk space for the remaining PBF plus a ${SOURCE_RESERVE / 1024 ** 3} GiB reserve`,
        );
      const record = join(this.directory, source.id + ".json");
      const job: SourceJob = {
        ...source,
        state: "queued",
        completed: offset,
        updatedAt: new Date().toISOString(),
        message: "Starting source download…",
      };
      delete job.error;
      const bundle = await Bun.build({
        entrypoints: [new URL("./source-worker.ts", import.meta.url).pathname],
        target: "bun",
        minify: false,
      });
      if (!bundle.success) throw new Error("Cannot build source worker");
      const worker = join(this.directory, source.id + ".worker.js");
      await Bun.write(worker, bundle.outputs[0]!);
      await Bun.write(record + ".tmp", JSON.stringify(job));
      await rename(record + ".tmp", record);
      try {
        if (this.systemd) {
          // Retain failed transient units for diagnostics; release them before retrying.
          await Bun.spawn(
            [
              "systemctl",
              "--user",
              "reset-failed",
              `atlas-source-${source.id}.service`,
            ],
            { stdout: "ignore", stderr: "ignore" },
          ).exited;
          const p = Bun.spawn(
            [
              "systemd-run",
              "--user",
              `--unit=atlas-source-${source.id}`,
              "--property=MemoryMax=1G",
              "--property=Nice=10",
              "--property=TimeoutStopSec=30",
              process.execPath,
              "--smol",
              worker,
              record,
            ],
            { stdout: "ignore", stderr: "pipe" },
          );
          const error = new Response(p.stderr).text();
          if (await p.exited) throw new Error(await error);
        } else {
          const p = Bun.spawn([process.execPath, "--smol", worker, record], {
            stdout: "ignore",
            stderr: "ignore",
          });
          this.children.set(source.id, p);
          void p.exited.finally(() => this.children.delete(source.id));
        }
      } catch (e) {
        job.state = "failed";
        job.error = String(e);
        await Bun.write(record, JSON.stringify(job));
        throw e;
      }
      return job;
    } finally {
      this.busy = false;
    }
  }
  async handle(request: Request, peer?: string) {
    const json = (value: unknown, status = 200) =>
      Response.json(value, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    if (!this.access(request, peer)) return json({ error: ADMIN_DENIED }, 403);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/admin/sources/europe") {
      try {
        const region = (await this.regions.regions()).find(
          (r) => r.id === "europe",
        );
        if (!region)
          throw new Error("Europe is missing from the provider catalog");
        const recipeFile = Bun.file(join(this.directory, "europe-recipe.json"));
        return json({
          bounds: region.bounds,
          name: region.name,
          recipe: (await recipeFile.exists()) ? await recipeFile.json() : null,
        });
      } catch (e) {
        return json({ error: String(e) }, 400);
      }
    }
    if (request.method === "GET" && url.pathname === "/admin/sources")
      return json({
        jobs: await this.list(),
        locations: await Promise.all(
          (await this.list()).map(async (j) => {
            const f = Bun.file(
              join(this.directory, j.id + ".location-progress.json"),
            );
            if (!(await f.exists())) return null;
            const p = await f.json();
            if (p.state === "verifying" && p.pid) {
              try {
                process.kill(p.pid, 0);
              } catch {
                p.state = "failed";
                p.message =
                  "Verification interrupted. Verify this location again; the original source is retained.";
              }
            }
            return p;
          }),
        ).then((xs) => xs.filter(Boolean)),
        storage: await readStorage(this.directory),
        reserveBytes: SOURCE_RESERVE,
      });
    if (
      request.method !== "POST" ||
      request.headers.get("Origin") !== url.origin ||
      request.headers.get("Content-Type") !== "application/json"
    )
      return json({ error: "Same-origin JSON request required" }, 403);
    try {
      const body = await request.json();
      if (url.pathname === "/admin/sources/location") {
        if (this.busy) throw new Error("A source action is already running");
        if (typeof body.path !== "string" || body.path.length > 2048)
          throw new Error("Supply a mounted server file path");
        this.busy = true;
        void registerSourceLocation(this.directory, body.id, body.path)
          .catch(async (error) => {
            if (/^[a-f0-9]{32}$/.test(body.id))
              await Bun.write(
                join(this.directory, body.id + ".location-progress.json"),
                JSON.stringify({
                  id: body.id,
                  state: "failed",
                  path: body.path,
                  completed: 0,
                  bytes: 0,
                  message: String(error),
                }),
              );
          })
          .finally(() => {
            this.busy = false;
          });
        return json(
          {
            message:
              "Verification started. The original source remains untouched.",
          },
          202,
        );
      }
      if (url.pathname === "/admin/sources/europe-recipe") {
        validateSelectionScope(body.selection, WORLD_SOURCE);
        const region = (await this.regions.regions()).find(
          (r) => r.id === "europe",
        );
        if (!region) throw new Error("Europe source coverage unavailable");
        const [w, south, e, n] = region.bounds;
        if (
          JSON.stringify(body.selection.polygon) !==
          JSON.stringify([
            [w, south],
            [e, south],
            [e, n],
            [w, n],
          ])
        )
          throw new Error("Europe recipe must use the provider's full extent");
        const recipe = {
          version: 1,
          region: "europe",
          source: "cached-planet-or-europe",
          selection: body.selection,
          savedAt: new Date().toISOString(),
          state: "ready-to-build",
          message:
            "Recipe saved. Start a preparation using a verified cached PBF; the partitioned compiler will build the selected capabilities.",
        };
        await mkdir(this.directory, { recursive: true });
        const file = join(this.directory, "europe-recipe.json");
        await Bun.write(file + ".tmp", JSON.stringify(recipe, null, 2));
        await rename(file + ".tmp", file);
        return json(recipe);
      }
      if (url.pathname === "/admin/sources/inspect") {
        const source = await inspectSource(body.kind as SourceKind);
        if (this.plans.size > 32) this.plans.clear();
        this.plans.set(source.id, source);
        return json(source);
      }
      if (url.pathname === "/admin/sources/start") {
        const source = this.plans.get(body.id);
        if (!source || Date.now() - Date.parse(source.inspectedAt) > 150000)
          throw new Error("Check the source again before starting");
        return json(await this.launch(source), 202);
      }
      if (!/^[a-f0-9]{32}$/.test(body.id ?? ""))
        throw new Error("Invalid source ID");
      const job = (await this.list()).find((j) => j.id === body.id);
      if (!job) throw new Error("Source not found");
      if (url.pathname === "/admin/sources/resume")
        return json(await this.launch(job), 202);
      if (url.pathname === "/admin/sources/pause") {
        if (this.busy)
          throw new Error(
            "A source action is in progress; retry pause shortly",
          );
        this.busy = true;
        try {
          if (job.state === "waiting") {
            await this.save({
              ...job,
              state: "paused",
              message: "Removed from download queue",
              updatedAt: new Date().toISOString(),
            });
            return json({ ok: true });
          }
          if (this.systemd) {
            const p = Bun.spawn(
              ["systemctl", "--user", "stop", `atlas-source-${job.id}.service`],
              { stdout: "ignore", stderr: "ignore" },
            );
            if (await p.exited) throw new Error("Could not pause the download");
          } else {
            const p = this.children.get(job.id);
            p?.kill("SIGTERM");
            await p?.exited;
          }
          return json({ ok: true });
        } finally {
          this.busy = false;
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.queueTimer);
    // systemd workers deliberately survive map-server deployment/restart.
    for (const p of this.children.values()) p.kill("SIGTERM");
    await Promise.all([...this.children.values()].map((p) => p.exited));
  }
}
