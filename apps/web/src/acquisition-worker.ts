import { AtlasReader } from "../../../packages/format/src/reader";
import { BrowserBlockStore } from "../../../packages/format/src/store";
import {
  PinnedBlockStore,
  pinnedKey,
} from "../../../packages/format/src/pinned-store";
import { sha256 } from "../../../packages/format/src/index";
import {
  planAcquisition,
  type AcquisitionRequest,
  type AcquisitionSource,
  type AcquisitionPlan,
} from "../../../packages/acquisition/src/plan";
import {
  areaSummary,
  browserPlanBytes,
  type SavedArea,
  type SavedAreaRecord,
} from "../../../packages/acquisition/src/browser";
import { coverageFamilies } from "../../../packages/coverage/src/index";
const store = new PinnedBlockStore(),
  fallback = new BrowserBlockStore();
let seeds: Array<{ id: string; reader: AtlasReader }> = [],
  seq = 0;
const reads = new Map<
  number,
  { resolve(v: Uint8Array): void; reject(e: Error): void }
>();
let active: { id: number; abort: AbortController } | undefined;
const emit = (job: SavedArea) =>
  postMessage({ type: "job", job: areaSummary(job) });
async function save(job: SavedArea) {
  job.updatedAt = new Date().toISOString();
  const { plan, ...metadata } = job;
  await store.save({ ...metadata, review: areaSummary(job).plan });
  emit(job);
}
function sourceRead(source: number, start: number, end: number) {
  const id = ++seq;
  return new Promise<Uint8Array>((resolve, reject) => {
    reads.set(id, { resolve, reject });
    postMessage({ type: "read", id, job: active?.id, source, start, end });
  });
}
function sources(
  job: SavedArea,
  signal: AbortSignal,
  offline: boolean,
): AcquisitionSource[] {
  const values = job.sources.map((pin) => {
    const seed = seeds.find(
      (s) =>
        s.id === pin.id && s.reader.index.manifest.snapshot === pin.snapshot,
    );
    if (!seed)
      throw Error(
        "Select the original map revisions to resume this saved area.",
      );
    const reader = seed.reader.fork({
      store: store.forJob(job.id, fallback),
      purposes: undefined,
      cacheBudgets: { semantic: 4 * 1024 ** 2, map: 4 * 1024 ** 2 },
      onTransfer: (event) => postMessage({ type: "transfer", event }),
    });
    reader.offline = offline;
    signal.addEventListener("abort", () => reader.dispose(), { once: true });
    return {
      id: pin.id,
      reader,
      manifest: reader.index.manifest,
      location: "remote" as const,
      verified: true,
      bytes: reader.index.header.fileLength,
    };
  });
  return values;
}
async function execute(m: any, signal: AbortSignal) {
  if (m.action === "list")
    return (await store.jobs<SavedAreaRecord>()).map((j) => ({
      ...areaSummary(j),
      plan: j.review ?? areaSummary(j).plan,
    }));
  if (m.action === "catalog")
    return seeds.map((s) => ({
      id: s.id,
      name: s.reader.index.manifest.name,
      snapshot: s.reader.index.manifest.snapshot,
      bounds: s.reader.index.manifest.bounds,
      families: coverageFamilies(s.reader.index.manifest).map((f) => f.id),
    }));
  if (m.action === "remove") {
    await store.remove(m.input.id);
    return { removed: m.input.id };
  }
  const input = m.input;
  let job: SavedArea;
  if (m.action === "plan") {
    const request = input as AcquisitionRequest;
    job = {
      id: crypto.randomUUID(),
      request,
      state: "planning",
      message: "Inspecting coverage and block dependencies…",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completed: 0,
      total: 0,
      bytes: 0,
      reusedBytes: 0,
      sources: seeds
        .filter((s) => request.sourceIds.includes(s.id))
        .map((s) => ({ id: s.id, snapshot: s.reader.index.manifest.snapshot })),
    };
    await save(job);
  } else {
    const found = await store.job<SavedAreaRecord>(input.id);
    if (!found) throw Error("Saved area not found");
    job = {
      ...found,
      plan: found.plan ?? (await store.plan<AcquisitionPlan>(input.id)),
    };
  }
  let readers: AcquisitionSource[] = [];
  try {
    readers = sources(job, signal, m.offline);
    if (m.action === "plan" || !job.plan) {
      job.plan = await planAcquisition(
        job.request,
        readers,
        signal,
        (message) => {
          job.message = message;
          emit(job);
        },
      );
      signal.throwIfAborted();
      await store.savePlan(job.id, job.plan);
      job.state = "review";
      job.message =
        "Review the capabilities, byte estimate and coverage before saving.";
      await save(job);
      if (m.action === "plan") return areaSummary(job);
    }
    const plan = job.plan!;
    signal.throwIfAborted();
    if (plan.conflicts.length)
      throw Error(
        "Conflicting routing cells: choose compatible source revisions before acquiring.",
      );
    if (plan.incomplete && input.acceptPartial !== true)
      throw Error(
        "Coverage has gaps. Review them and explicitly accept partial coverage to continue.",
      );
    const estimate = await navigator.storage?.estimate();
    if (
      estimate?.quota &&
      browserPlanBytes(plan) > estimate.quota - (estimate.usage ?? 0) &&
      input.allowStorageRisk !== true
    )
      throw Error(
        "The selected blocks may exceed browser storage. Free space or explicitly allow the storage risk; a failed write will pause acquisition.",
      );
    const blocks = new Map<
      string,
      {
        source: AcquisitionSource;
        block: (typeof plan.parts)[number]["blocks"][number];
      }
    >();
    for (const part of plan.parts) {
      const source = readers.find((r) => r.id === part.sourceId)!;
      for (const block of part.blocks)
        blocks.set(pinnedKey(source.manifest.snapshot, block), {
          source,
          block,
        });
    }
    job.state = "fetching";
    job.total = blocks.size;
    job.completed = 0;
    job.bytes = 0;
    job.reusedBytes = 0;
    delete job.error;
    await save(job);
    let checkpoint = performance.now();
    for (const { source, block } of blocks.values()) {
      signal.throwIfAborted();
      const snapshot = source.manifest.snapshot;
      let bytes =
        (await store.get(snapshot, block)) ??
        (await fallback.get(snapshot, block));
      if (
        bytes &&
        (bytes.length !== block.length || (await sha256(bytes)) !== block.hash)
      )
        bytes = undefined;
      if (bytes) {
        await store.put(job.id, snapshot, block, bytes);
        job.reusedBytes += bytes.length;
      } else {
        await source.reader.block(block.key);
        // readBlock verifies before the durable store writes; cache memory is bounded.
        bytes = await store.get(snapshot, block);
        if (!bytes || (await sha256(bytes)) !== block.hash)
          throw Error(`Block was not saved: ${block.key}`);
        job.bytes += bytes.length;
      }
      job.completed++;
      job.message = `${job.completed.toLocaleString()} / ${job.total.toLocaleString()} blocks saved · ${block.key}`;
      if (performance.now() - checkpoint > 250 || job.completed === job.total) {
        await save(job);
        checkpoint = performance.now();
      }
    }
    signal.throwIfAborted();
    job.state = "ready";
    job.message =
      "Selected blocks saved. Map rendering, spatial analysis and routing can reuse them on this device.";
    await save(job);
    return areaSummary(job);
  } catch (error) {
    job.state = signal.aborted ? "paused" : "failed";
    job.error = signal.aborted ? undefined : String(error);
    job.message = signal.aborted
      ? "Paused. Verified blocks are kept for resume."
      : "Acquisition stopped; saved blocks are kept. Review the error and resume.";
    await save(job);
    if (signal.aborted) return areaSummary(job);
    throw error;
  } finally {
    for (const s of readers) s.reader.dispose();
  }
}
self.onmessage = ({ data: m }) => {
  if (m.type === "reply") {
    const r = reads.get(m.id);
    reads.delete(m.id);
    m.error ? r?.reject(Error(m.error)) : r?.resolve(m.value);
    return;
  }
  if (m.type === "cancel") {
    if (active && active.id === m.id) active.abort.abort();
    return;
  }
  if (m.type === "init") {
    seeds = m.sources.map((s: any, i: number) => {
      const seed = new AtlasReader({ read: (a, b) => sourceRead(i, a, b) });
      seed.index = s.index;
      const reader = seed.fork();
      seed.dispose();
      return { id: s.id, reader };
    });
    return;
  }
  if (m.type !== "call") return;
  if (active && !["list", "catalog"].includes(m.action)) {
    postMessage({
      type: "error",
      id: m.id,
      error: "An acquisition is already running; pause it first.",
    });
    return;
  }
  const controller = new AbortController(),
    mutation = !["list", "catalog"].includes(m.action);
  if (mutation) active = { id: m.id, abort: controller };
  void (async () => {
    try {
      const run = () => execute(m, controller.signal);
      const value = mutation
        ? await navigator.locks.request(
            "atlas-area-acquisition",
            { ifAvailable: true },
            (lock) => {
              if (!lock)
                throw Error("A saved-area operation is active in another tab.");
              return run();
            },
          )
        : await run();
      postMessage({ type: "result", id: m.id, value });
    } catch (e) {
      postMessage({ type: "error", id: m.id, error: String(e) });
    } finally {
      if (active?.id === m.id) active = undefined;
    }
  })();
};
