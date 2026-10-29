import type { PreparationJob } from "./preparations";

export interface BuildRecovery {
  retries: number;
  nextAttemptAt?: string;
  history: Array<{
    at: string;
    error: string;
    stage?: string;
    checkpointAt?: string;
    action: string;
  }>;
}
const delays = [60_000, 5 * 60_000, 15 * 60_000];
/** Fail closed for deterministic data errors. A retry is recovery, never evidence of a bug fix. */
export function retryableFailure(error: string) {
  if (
    /disk|space|ENOSPC|quota|budget|limit|corrupt|malformed|checksum|hash mismatch|snapshot changed|invalid|missing|not found|permission|denied/i.test(
      error,
    )
  )
    return false;
  return /SIGABRT|SIGSEGV|SIGBUS|SIGKILL|signal (?:6|7|9|11)|double free|out of memory|std::bad_alloc|process exited|server interrupted|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|HTTP 50[234]/i.test(
    error,
  );
}
export function recoverBuild(
  job: PreparationJob,
  error: string,
  now = Date.now(),
) {
  const recovery = (job.recovery ??= { retries: 0, history: [] });
  const delay = retryableFailure(error) ? delays[recovery.retries] : undefined;
  recovery.history.push({
    at: new Date(now).toISOString(),
    error,
    stage: job.progress.stage,
    checkpointAt: job.progress.checkpointAt,
    action: delay === undefined ? "Needs attention" : "Retry from checkpoints",
  });
  job.error = error;
  if (delay === undefined) {
    job.state = "failed";
    delete recovery.nextAttemptAt;
    return false;
  }
  recovery.retries++;
  recovery.nextAttemptAt = new Date(now + delay).toISOString();
  job.state = "queued";
  job.resumeCheckpoint = true;
  job.progress.message = `Automatic recovery ${recovery.retries} of ${delays.length}; saved checkpoints retained.`;
  return true;
}
