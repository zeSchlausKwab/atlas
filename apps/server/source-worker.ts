import { readFile, rename, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import {
  cacheSourceWithRetries,
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
  const result = await cacheSourceWithRetries(
    job,
    dirname(record),
    abort.signal,
    async (state, completed, message) => {
      job.state = state;
      job.completed = completed;
      job.message =
        message ??
        (state === "verifying"
          ? "Checking the published MD5 and computing SHA-256…"
          : "Downloading to server disk. Leaving the page does not interrupt this job.");
      const disk = await statfs(dirname(record));
      if (disk.bavail * disk.bsize < SOURCE_RESERVE)
        throw new Error("Paused to preserve 60 GiB of free disk space");
      delete job.error;
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
  if (!abort.signal.aborted) {
    console.error("Source download failed:", error);
    process.exitCode = 1;
  }
  job.state = abort.signal.aborted ? "paused" : "failed";
  job.error = abort.signal.aborted ? undefined : String(error);
  job.message =
    "Partial download retained. Resume continues from the saved bytes.";
}
await save();
