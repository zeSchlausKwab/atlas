import { mkdir, readdir, rename, rm, link } from "node:fs/promises";
import { join } from "node:path";
import {
  planAcquisition,
  validateAcquisition,
  type AcquisitionRequest,
  type AcquisitionPlan,
  type AcquisitionSource,
} from "../../packages/acquisition/src/plan";
import type { CoverageSource } from "../../packages/coverage/src/index";
import { AtlasReader, FileSource } from "../../packages/format/src/reader";
import { openMembers } from "../../packages/format/src/composition";
import type { MapOffer } from "../../packages/format/src/catalog";
import { HashtreeSource } from "../../packages/hashtree/src/source";
import { verifyPublishedMap } from "../../packages/hashtree/src/published-map";
import { preparePackage } from "../../packages/provisioning/src/prepare";
import { packComposition } from "../../packages/provisioning/src/composition";
import {
  checkStorageEstimate,
  DISK_RESERVE,
  NO_SIZE_LIMIT,
} from "../../packages/provisioning/src/capacity";
import { readStorage } from "./storage";
import { AcquisitionCache } from "./acquisition-cache";
export interface AcquisitionPin extends CoverageSource {
  offer?: MapOffer;
  path?: string;
  memberId?: string;
}
type State =
  | "planning"
  | "review"
  | "fetching"
  | "packing"
  | "paused"
  | "failed"
  | "ready";
interface Job {
  id: string;
  createdAt: string;
  state: State;
  request: AcquisitionRequest;
  sources: AcquisitionPin[];
  message: string;
  completed: number;
  total: number;
  bytes: number;
  reusedBytes: number;
  plan?: AcquisitionPlan;
  error?: string;
  completedParts: number[];
  allowStorageRisk?: boolean;
  acceptedPartial?: boolean;
  imported?: boolean;
}
const activeStates = new Set<State>(["planning", "fetching", "packing"]);
export class Acquisitions {
  private jobs = new Map<string, Job>();
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private closing = false;
  private saving = Promise.resolve();
  private commands = Promise.resolve();
  private command<T>(work: () => Promise<T>): Promise<T> {
    const result = this.commands.then(work);
    this.commands = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private constructor(
    readonly directory: string,
    private publish: (
      id: string,
      path: string,
      name: string,
      force: boolean,
    ) => Promise<void>,
  ) {}
  static async open(directory: string, publish: Acquisitions["publish"]) {
    await mkdir(directory, { recursive: true });
    const manager = new Acquisitions(directory, publish);
    for (const name of await readdir(directory))
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const j: Job = await Bun.file(join(directory, name)).json();
        const plan = Bun.file(join(manager.folder(j.id), "plan.json"));
        if (await plan.exists()) j.plan = await plan.json();
        if (activeStates.has(j.state)) {
          j.state = "paused";
          j.message = "Server restarted. Resume from verified cached blocks.";
        }
        manager.jobs.set(j.id, j);
      }
    return manager;
  }
  private folder(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid acquisition ID");
    return join(this.directory, id);
  }
  private save(j: Job) {
    const { plan, ...state } = j;
    const data = JSON.stringify(state),
      path = join(this.directory, j.id + ".json");
    const work = this.saving.then(async () => {
      await Bun.write(path + ".tmp", data);
      await rename(path + ".tmp", path);
    });
    this.saving = work.catch(() => {});
    return work;
  }
  view() {
    return [...this.jobs.values()].map(
      ({ sources, plan, completedParts, ...j }) => ({
        ...j,
        plan: plan && {
          request: plan.request,
          coverage: plan.coverage.map((c) => ({
            family: c.request.family,
            zoom: c.request.zoom,
            totals: c.totals,
            areaM2: c.areaM2,
          })),
          conflicts: plan.conflicts,
          incomplete: plan.incomplete,
          storedBytes: plan.storedBytes,
          localBytes: plan.localBytes,
          remoteBytes: plan.remoteBytes,
          blocks: plan.parts.reduce((n, p) => n + p.blocks.length, 0),
          members: plan.parts.length,
          notes: plan.notes,
        },
      }),
    );
  }
  create(request: AcquisitionRequest, sources: AcquisitionPin[]) {
    return this.command(() => this.createJob(request, sources));
  }
  private async createJob(
    request: AcquisitionRequest,
    sources: AcquisitionPin[],
  ) {
    this.idle();
    validateAcquisition(request);
    const pins = sources.filter((s) => request.sourceIds.includes(s.id));
    if (pins.length !== new Set(request.sourceIds).size)
      throw Error("Refresh and select available sources.");
    const j: Job = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      state: "paused",
      request: structuredClone(request),
      sources: structuredClone(pins),
      message: "Queued for dependency planning",
      completed: 0,
      total: 0,
      bytes: 0,
      reusedBytes: 0,
      completedParts: [],
    };
    await mkdir(this.folder(j.id), { recursive: true });
    await this.save(j);
    this.jobs.set(j.id, j);
    this.run(j, false);
    return j.id;
  }
  private idle() {
    if (this.active || this.closing)
      throw Error("Pause the active area acquisition before starting another.");
  }
  resume(id: string, force = false, acceptPartial = false) {
    return this.command(() => this.resumeJob(id, force, acceptPartial));
  }
  private async resumeJob(id: string, force: boolean, acceptPartial: boolean) {
    this.idle();
    const j = this.jobs.get(id);
    if (!j) throw Error("Acquisition not found");
    if (j.state === "ready") return;
    if (j.plan) {
      if (j.plan.conflicts.length)
        throw Error(
          "Routing sources disagree. Select compatible sources and review a new plan.",
        );
      if (j.plan.incomplete && !acceptPartial && !j.acceptedPartial)
        throw Error(
          "Coverage has gaps. Explicitly choose to acquire available data, or add sources.",
        );
      // Admission allowance only; exact output size is known after rebuilding indexes.
      checkStorageEstimate(
        DISK_RESERVE + 64 * 1024 ** 2 + j.plan.storedBytes * 6,
        (await readStorage(this.directory)).availableBytes,
        force,
      );
      j.allowStorageRisk = force;
      j.acceptedPartial = acceptPartial || j.acceptedPartial;
    }
    this.run(j, !!j.plan);
  }
  async pause(id: string) {
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active.done;
    }
  }
  remove(id: string) {
    return this.command(() => this.removeJob(id));
  }
  private async removeJob(id: string) {
    if (this.active?.id === id)
      throw Error("Pause this acquisition before deleting it.");
    if (!this.jobs.has(id)) throw Error("Acquisition not found");
    await this.saving;
    await rm(join(this.directory, id + ".json"), { force: true });
    this.jobs.delete(id);
    await rm(this.folder(id), { recursive: true, force: true });
  }
  publishFile(id: string, force = false) {
    return this.command(() => this.publishJob(id, force));
  }
  private async publishJob(id: string, force: boolean) {
    const j = this.jobs.get(id);
    if (!j || j.state !== "ready") throw Error("Finish the acquisition first.");
    if (!j.imported) {
      await this.publish(
        id,
        join(this.folder(id), "complete.atlas"),
        j.request.name,
        force,
      );
      j.imported = true;
      await this.save(j);
    }
  }
  file(id: string) {
    const j = this.jobs.get(id);
    if (!j || j.state !== "ready") throw Error("Finished file not found");
    return Bun.file(join(this.folder(id), "complete.atlas"));
  }
  private run(j: Job, execute: boolean) {
    this.idle();
    const abort = new AbortController();
    const signal = abort.signal;
    const done = (async () => {
      const opened: AtlasReader[] = [];
      let lastSpace = 0;
      let offline = false;
      const guard = async (bytes = 0) => {
        signal.throwIfAborted();
        if (Date.now() - lastSpace < 2000) return;
        lastSpace = Date.now();
        if (
          (await readStorage(this.directory)).availableBytes - bytes <
          DISK_RESERVE
        )
          throw Error(
            "Acquisition paused to preserve 10 GiB free. Free space and resume; verified blocks are kept.",
          );
      };
      const monitor = setInterval(() => {
        void guard().catch((e) => {
          j.error = String(e);
          abort.abort();
        });
      }, 2000);
      const cache = new AcquisitionCache(
        join(this.folder(j.id), "cache"),
        guard,
      );
      const update = (message: string) => {
        j.message = message;
      };
      const onAbort = () => opened.forEach((r) => r.dispose());
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        j.state = execute ? "fetching" : "planning";
        delete j.error;
        await this.save(j);
        const sources: AcquisitionSource[] = [];
        for (const pin of j.sources.filter(
          (s) =>
            s.verified &&
            (!j.plan || j.plan.parts.some((p) => p.sourceId === s.id)),
        )) {
          signal.throwIfAborted();
          update(`Opening pinned source ${pin.manifest.name}…`);
          const source = pin.offer
            ? new HashtreeSource(
                pin.offer.url,
                pin.offer.hashtree!,
                pin.offer.api,
                {
                  store: cache,
                  memoryBytes: 1024 ** 2,
                  offline: () => offline,
                },
              )
            : new FileSource(Bun.file(pin.path!));
          const parent = new AtlasReader(source, undefined, {
            store: cache,
            directoryBudget: 1024 ** 2,
          });
          opened.push(parent);
          await parent.open();
          if (pin.offer) verifyPublishedMap(pin.offer, parent);
          let reader = parent;
          if (pin.memberId) {
            const members = await openMembers(parent);
            opened.push(...members.map((m) => m.reader));
            reader = members
              .find((m) => m.id === pin.memberId)
              ?.reader.fork({ store: cache })!;
            if (reader) opened.push(reader);
          }
          if (
            !reader ||
            reader.index.manifest.snapshot !== pin.manifest.snapshot
          )
            throw Error(`Pinned snapshot changed: ${pin.manifest.name}`);
          sources.push({ ...pin, reader });
        }
        if (!j.plan) {
          // Unverified entries still contribute unknown coverage; never acquire their bytes.
          const all = j.sources.map(
            (pin) =>
              sources.find((s) => s.id === pin.id) ?? {
                ...pin,
                reader: undefined as unknown as AtlasReader,
              },
          );
          const plan = await planAcquisition(j.request, all, signal, update);
          const planPath = join(this.folder(j.id), "plan.json");
          await Bun.write(planPath + ".tmp", JSON.stringify(plan));
          await rename(planPath + ".tmp", planPath);
          j.plan = plan;
          j.reusedBytes = 0;
          const seen = new Set<string>();
          for (const p of j.plan.parts)
            for (const b of p.blocks)
              if (!seen.has(b.hash)) {
                seen.add(b.hash);
                if (await cache.has(b)) j.reusedBytes += b.length;
              }
          j.state = "review";
          j.message =
            "Plan ready. Review coverage, dependencies and estimated transfer before acquiring.";
          await this.save(j);
          return;
        }
        j.completed = 0;
        j.total = j.plan.parts.reduce((n, p) => n + p.blocks.length, 0);
        j.bytes = 0;
        j.reusedBytes = 0;
        for (const part of [...j.plan.parts].sort(
          (a, b) =>
            Number(
              j.sources.find((s) => s.id === a.sourceId)!.location === "remote",
            ) -
            Number(
              j.sources.find((s) => s.id === b.sourceId)!.location === "remote",
            ),
        )) {
          const reader = sources.find((s) => s.id === part.sourceId)!.reader;
          for (const b of part.blocks) {
            await guard();
            update(`Acquiring ${j.completed + 1}/${j.total} · ${b.key}`);
            const cached = await cache.has(b);
            await reader.block(b.key);
            signal.throwIfAborted();
            reader.cache.delete(b.key);
            j.completed++;
            j.bytes += b.length;
            if (cached) j.reusedBytes += b.length;
            if (j.completed % 64 === 0) await this.save(j);
          }
        }
        j.state = "packing";
        await this.save(j);
        // From here on the exporter is deliberately offline. Missing dependencies
        // are a planner bug, not permission to invisibly fetch additional data.
        offline = true;
        for (const r of opened) r.offline = true;
        const partReaders: AtlasReader[] = [];
        for (let i = 0; i < j.plan.parts.length; i++) {
          const part = j.plan.parts[i]!,
            path = join(this.folder(j.id), `part-${i}.atlas`);
          if (!j.completedParts.includes(i)) {
            await rm(path, { force: true });
            await preparePackage(
              sources.find((s) => s.id === part.sourceId)!.reader,
              part.selection,
              path,
              signal,
              (p) =>
                update(
                  `Member ${i + 1}/${j.plan!.parts.length} · ${p.message}`,
                ),
            );
            j.completedParts.push(i);
            await this.save(j);
          }
          const r = new AtlasReader(new FileSource(Bun.file(path)));
          opened.push(r);
          await r.open();
          partReaders.push(r);
        }
        signal.throwIfAborted();
        await guard();
        const output = join(this.folder(j.id), "complete.atlas");
        await rm(output, { force: true });
        if (partReaders.length === 1)
          await link(join(this.folder(j.id), "part-0.atlas"), output);
        else
          await packComposition(
            partReaders,
            j.request.name,
            output,
            NO_SIZE_LIMIT,
            signal,
            (p) => update(p.message),
          );
        signal.throwIfAborted();
        j.state = "ready";
        j.message = j.plan.incomplete
          ? "Available data assembled; coverage gaps remain in the saved report."
          : "Selected data assembled into one self-contained Atlas file.";
      } catch (e) {
        j.state = signal.aborted ? "paused" : "failed";
        j.error = signal.aborted ? j.error : String(e);
        j.message = signal.aborted
          ? "Paused. Verified blocks and finished members are kept."
          : "Acquisition stopped. Fix the issue and resume verified blocks.";
      } finally {
        clearInterval(monitor);
        signal.removeEventListener("abort", onAbort);
        opened.forEach((r) => r.dispose());
        await this.save(j);
      }
    })()
      .catch((e) => {
        j.state = "failed";
        j.error = String(e);
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { id: j.id, abort, done };
  }
  async close() {
    this.closing = true;
    await this.commands;
    this.active?.abort.abort();
    await this.active?.done;
    await this.saving;
  }
}
