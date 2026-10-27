/** Durable coordinator for ordinary host jobs. The host UI owns stop/resume/delete. */
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { PreparationJob } from "../apps/server/preparations";
import type { PackageSelection } from "../packages/provisioning/src/selection";
export interface PairPlan {
  server: string;
  sourceId: string;
  sourceHash: string;
  parent: PackageSelection;
  chunks: [PackageSelection, PackageSelection];
}
export async function hostedPair(plan: PairPlan, path: string, pollMs = 10000) {
  const server = new URL(plan.server).origin;
  const identity = createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
  await mkdir(dirname(path), { recursive: true });
  const state = (await Bun.file(path).exists())
    ? await Bun.file(path).json()
    : { identity, createdAt: new Date().toISOString(), jobs: {} };
  if (state.identity !== identity)
    throw new Error("Pair recipe changed; use a new state file");
  const save = async () => {
    await Bun.write(path + ".part", JSON.stringify(state, null, 2));
    await rename(path + ".part", path);
  };
  await save();
  const request = async (url: string, body?: unknown) => {
    const r = await fetch(server + url, {
      method: body ? "POST" : "GET",
      headers: body
        ? { Origin: server, "Content-Type": "application/json" }
        : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  };
  try {
    const info = await request("/admin/preparations");
    if (
      !state.jobs.parent &&
      !info.cachedSources?.some(
        (s: any) => s.id === plan.sourceId && s.sha256 === plan.sourceHash,
      )
    )
      throw new Error("Pinned source is not available on this host");
    const ensure = async (
      key: string,
      selection: PackageSelection,
      extra: Record<string, string>,
    ) => {
      const jobs: PreparationJob[] = (await request("/admin/preparations"))
        .jobs;
      if (!state.jobs[key]) {
        // Recover a completed POST if the coordinator died before saving its returned ID.
        const matches = jobs.filter(
          (j) =>
            j.createdAt >= state.createdAt &&
            j.name === selection.name &&
            Object.entries({ ...selection, ...extra }).every(
              ([k, v]) =>
                JSON.stringify((j.selection as any)[k]) === JSON.stringify(v),
            ),
        );
        if (matches.length > 1)
          throw new Error("Ambiguous saved build; inspect host jobs");
        state.jobs[key] =
          matches[0]?.id ??
          (await request("/admin/preparations", { ...selection, ...extra })).id;
        await save();
      }
      for (;;) {
        const job: PreparationJob = (
          await request("/admin/preparations")
        ).jobs.find((j: PreparationJob) => j.id === state.jobs[key]);
        if (!job) throw new Error(`Saved ${key} job disappeared`);
        const message = `${key}: ${job.state} · ${job.progress?.message ?? ""}`;
        if (state.message !== message) {
          state.message = message;
          state.phase = key;
          await save();
          console.log(message);
        }
        if (job.state === "ready") return job;
        if (job.state !== "running")
          throw new Error(
            `${key} ${job.state}: ${job.error ?? "Resume this build in the host UI, then rerun this coordinator."}`,
          );
        await Bun.sleep(pollMs);
      }
    };
    const parent = await ensure("parent", plan.parent, {
      cachedSourceId: plan.sourceId,
    });
    const children = [];
    for (const [i, s] of plan.chunks.entries()) {
      const child = await ensure(
        i === 0 ? "west" : "east",
        { ...s, snapshot: parent.manifest!.snapshot },
        { sourceAtlasId: parent.id },
      );
      const m = child.manifest!;
      if (
        m.selection?.parentSnapshot !== parent.manifest!.snapshot ||
        m.semantics?.addresses !== "osm-explicit" ||
        !["walking", "cycling", "driving"].every(
          (p) => m.transport?.profiles[p as "walking"],
        ) ||
        m.transport?.graphSnapshot !== parent.manifest!.transport?.graphSnapshot
      )
        throw new Error(
          "Prepared child lost shared graph or address capability",
        );
      children.push(child);
    }
    for (const child of children) {
      let job = (await request("/admin/discovery")).jobs.find(
        (j: any) => j.id === child.id,
      );
      if (job?.state !== "ready" && job?.state !== "indexing")
        await request("/admin/discovery", { id: child.id });
      for (;;) {
        job = (await request("/admin/discovery")).jobs.find(
          (j: any) => j.id === child.id,
        );
        if (job?.state === "ready") break;
        if (job?.state !== "indexing")
          throw Error(job?.message ?? "Publication missing");
        await Bun.sleep(pollMs);
      }
    }
    state.phase = "ready";
    state.message =
      "Both shared-source chunks are ready and published. Run cross-map route and workspace acceptance checks before retiring the parent.";
    state.maps = children.map((j) => ({
      id: j.id,
      name: j.name,
      bytes: j.size,
    }));
    delete state.error;
    await save();
    console.log(state.message);
    return state;
  } catch (error) {
    state.error = String(error);
    await save();
    throw error;
  }
}
if (import.meta.main) {
  const config = process.argv[2];
  if (!config)
    throw Error("Usage: bun scripts/hosted-pair.ts PLAN.json [STATE.json]");
  await hostedPair(
    await Bun.file(config).json(),
    resolve(process.argv[3] ?? config + ".state.json"),
  );
}
