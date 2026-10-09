import { mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import type { Manifest } from "../../packages/format/src/index";
import {
  availability,
  validateSelection,
  type PackageSelection,
  type PreparationProgress,
} from "../../packages/provisioning/src/selection";
export interface PreparationJob {
  id: string;
  name: string;
  createdAt: string;
  state: "running" | "cancelling" | "cancelled" | "failed" | "ready";
  selection: PackageSelection;
  progress: PreparationProgress;
  error?: string;
  size?: number;
  manifest?: Manifest;
}
export class Preparations {
  readonly jobs = new Map<string, PreparationJob>();
  private worker?: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private active?: string;
  private writes = Promise.resolve();
  private settling?: Promise<void>;
  private constructor(
    readonly directory: string,
    readonly sourcePath: string,
    readonly source: Manifest,
  ) {}
  static async open(directory: string, sourcePath: string, source: Manifest) {
    const manager = new Preparations(directory, sourcePath, source);
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
        job.error =
          "Server stopped during preparation. Create the excerpt again.";
        await manager.cleanup(job.id);
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
  private async cleanup(id: string) {
    for (const suffix of ["", ".part", ".payload.part"])
      await rm(this.path(id) + suffix, { force: true });
  }
  async create(value: unknown) {
    validateSelection(value, this.source);
    if (this.active)
      throw new Error(
        "Another preparation is running. Wait for it or cancel it first.",
      );
    const id = crypto.randomUUID();
    this.active = id;
    try {
      const disk = await statfs(this.directory);
      if (disk.bavail * disk.bsize < value.maxBytes * 2 + 64 * 1024 * 1024)
        throw new Error(
          "Insufficient free disk space for the selected output budget and temporary copy. Lower the budget.",
        );
      const job: PreparationJob = {
        id,
        name: value.name.trim(),
        createdAt: new Date().toISOString(),
        state: "running",
        selection: structuredClone(value),
        progress: {
          phase: "planning",
          message: "Opening the source snapshot…",
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
          } else await this.cleanup(id);
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
    job.progress.message = "Cancelling and removing partial files…";
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
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress ?? "") ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return json({ error: "Local administration only" }, 403);
    if (request.method === "GET" && url.pathname === "/admin/preparations")
      return json({
        source: this.source,
        available: availability(this.source),
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
        /^\/admin\/preparations\/([a-f0-9-]{36})\/cancel$/,
      );
      if (match) return json(await this.cancel(match[1]!));
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
