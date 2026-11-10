#!/usr/bin/env bun
/** Explicit host maintenance; never moves a live writable SQLite store onto SMB. */
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import {
  parkCheckpoints,
  restoreCheckpoints,
} from "../packages/provisioning/src/checkpoint-parking";
const { values: o } = parseArgs({
  args: process.argv.slice(2),
  options: {
    work: { type: "string" },
    archive: { type: "string" },
    file: { type: "string", multiple: true },
    server: { type: "string", default: "http://127.0.0.1:3100" },
    job: { type: "string" },
    "then-resume": { type: "string", multiple: true },
    restore: { type: "boolean", default: false },
  },
});
if (!o.work || !o.job || !/^[a-f0-9-]{36}$/.test(o.job))
  throw Error(
    "Provide --work and --job; parking also requires --archive and --file",
  );
if (basename(resolve(o.work)) !== `${o.job}.work`)
  throw Error("Workspace directory must match the stopped job ID");
const base = new URL(o.server!);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
  throw Error("Run maintenance on the server using its loopback API");
const jobs = async () => {
  const r = await fetch(new URL("/admin/preparations", base));
  if (!r.ok) throw Error(await r.text());
  return (await r.json()).jobs;
};
const idle = async () => {
  const j = (await jobs()).find((j: any) => j.id === o.job);
  if (!j || !["cancelled", "failed"].includes(j.state))
    throw Error(
      "Stop the selected build before parking or restoring checkpoints",
    );
};
if (o.restore) await restoreCheckpoints(o.work, idle);
else {
  if (!o.archive || !o.file?.length)
    throw Error("Provide --archive and --file");
  await parkCheckpoints({
    work: o.work,
    archive: o.archive,
    files: o.file,
    checkIdle: idle,
    progress: (s) =>
      console.log(
        JSON.stringify({
          phase: s.phase,
          file: s.file,
          completed: s.completed,
          total: s.total,
          at: s.updatedAt,
        }),
      ),
  });
  // Queue once only; user cancellation or already-started jobs are respected.
  const statusFile = resolve(o.work, "parking-followup.json");
  const completed = (await Bun.file(statusFile).exists())
    ? await Bun.file(statusFile).json()
    : [];
  for (const id of o["then-resume"] ?? []) {
    if (completed.includes(id)) continue;
    const j = (await jobs()).find((j: any) => j.id === id);
    if (!j || j.state !== "failed" || !/space|GiB/.test(j.error ?? "")) {
      console.log("Follow-up unchanged: " + id);
      continue;
    }
    const r = await fetch(
      new URL("/admin/preparations/" + id + "/resume", base),
      {
        method: "POST",
        headers: { Origin: base.origin, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!r.ok) throw Error("Follow-up " + id + ": " + (await r.text()));
    completed.push(id);
    await Bun.write(statusFile, JSON.stringify(completed));
    console.log(JSON.stringify({ resumed: id, state: (await r.json()).state }));
  }
}
