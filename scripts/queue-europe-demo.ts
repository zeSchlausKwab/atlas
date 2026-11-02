#!/usr/bin/env bun
/** Three independent preparations from one pinned OSM authority. Dry run by default. */
import { dirname } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { europeDemoPlan } from "./europe-demo-plan";
const args = process.argv.slice(2),
  queue = args.includes("--queue");
const option = (name: string, fallback: string) =>
  args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ??
  fallback;
const base = new URL(option("--server", "http://127.0.0.1:3100"));
const profile = option("--recipe", "europe");
if (profile !== "europe" && profile !== "north-sea")
  throw Error("Unknown --recipe; choose europe or north-sea");
const receiptPath = option(
  "--receipt",
  `data/${profile}-independent-receipt.json`,
);
const east = Number(option("--east", "27"));
const onlyOption = option("--only", "");
const request = async (path: string, body?: unknown) => {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: body
      ? { Origin: base.origin, "Content-Type": "application/json" }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Error(JSON.stringify(data));
  return data;
};
const config = await request("/admin/preparations"),
  plan = europeDemoPlan(config, east, profile);
const only = onlyOption ? onlyOption.split(",") : plan.maps.map((m) => m.key);
if (!only.length || only.some((k) => !plan.maps.some((m) => m.key === k)))
  throw Error("Invalid --only map keys");
const identity = createHash("sha256")
  .update(JSON.stringify({ server: base.origin, plan }))
  .digest("hex");
const receipt: {
  version: number;
  identity: string;
  createdAt: string;
  jobs: Record<string, string>;
} = (await Bun.file(receiptPath).exists())
  ? await Bun.file(receiptPath).json()
  : { version: 2, identity, createdAt: new Date().toISOString(), jobs: {} };
if (receipt.version !== 2 || receipt.identity !== identity)
  throw Error(
    "Receipt belongs to a different source, area, server or legacy parent-map recipe. Use a new receipt path.",
  );
const save = async () => {
  await mkdir(dirname(receiptPath), { recursive: true });
  await Bun.write(receiptPath + ".tmp", JSON.stringify(receipt, null, 2));
  await rename(receiptPath + ".tmp", receiptPath);
};
if (queue) await save();
for (const map of plan.maps.filter((m) => only.includes(m.key))) {
  if (!queue) {
    console.log(JSON.stringify(map, null, 2));
    continue;
  }
  const current = await request("/admin/preparations");
  if (
    !current.cachedSources.some(
      (s: any) => s.id === plan.source && s.sha256 === plan.sourceRevision,
    )
  )
    throw Error("Pinned planet source changed while queuing");
  const jobs = current.jobs;
  if (receipt.jobs[map.key]) {
    if (!jobs.some((j: any) => j.id === receipt.jobs[map.key]))
      throw Error(
        "Saved build disappeared; inspect the receipt before queuing again",
      );
    console.log(`${map.key}: already submitted (${receipt.jobs[map.key]})`);
    continue;
  }
  // Recover an accepted POST if the caller stopped before saving its returned id.
  const matches = jobs.filter(
    (j: any) =>
      j.createdAt >= receipt.createdAt &&
      !["cancelled", "deleting"].includes(j.state) &&
      Object.entries(map.selection).every(
        ([k, v]) => JSON.stringify(j.selection[k]) === JSON.stringify(v),
      ),
  );
  if (matches.length > 1)
    throw Error("Ambiguous preparation; inspect host jobs before retrying");
  const job =
    matches[0] ?? (await request("/admin/preparations", map.selection));
  receipt.jobs[map.key] = job.id;
  await save();
  console.log(
    JSON.stringify({
      key: map.key,
      id: job.id,
      state: job.state,
      message: job.progress.message,
    }),
  );
}
console.log(
  queue
    ? `Queue receipt saved to ${receiptPath}. Each job reads the retained planet independently; the host schedules one compiler at a time.`
    : "Dry run only. Add --queue to submit. --recipe=north-sea selects the reduced three-map demo, smaller pair first. --only accepts comma-separated recipe keys.",
);
