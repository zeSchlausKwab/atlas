import { readFile, rename, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import {
  cacheSource,
  SOURCE_RESERVE,
  type SourceJob,
} from "../../packages/provisioning/src/source-cache";
const record = process.argv[2]!;
const job = JSON.parse(await readFile(record, "utf8")) as SourceJob;
const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => abort.abort());
const save = async () => {
  job.updatedAt = new Date().toISOString();
  await Bun.write(record + ".tmp", JSON.stringify(job));
  await rename(record + ".tmp", record);
};
try {
  const result = await cacheSource(
    job,
    dirname(record),
    abort.signal,
    async (state, completed) => {
      job.state = state;
      job.completed = completed;
      job.message =
        state === "verifying"
          ? "Checking the published MD5 and computing SHA-256…"
          : "Downloading to server disk. Leaving the page does not interrupt this job.";
      const disk = await statfs(dirname(record));
      if (disk.bavail * disk.bsize < SOURCE_RESERVE)
        throw new Error("Paused to preserve 60 GiB of free disk space");
      await save();
    },
  );
  job.state = "ready";
  job.completed = job.bytes;
  job.sha256 = result.sha256;
  job.message =
    "Source verified and cached. Map compilation is a separate step.";
  delete job.error;
} catch (error) {
  job.state = abort.signal.aborted ? "paused" : "failed";
  job.error = abort.signal.aborted ? undefined : String(error);
  job.message =
    "Partial download retained. Resume continues from the saved bytes.";
}
await save();
