import { serveWorker } from "../../packages/compiler/src/process-pool";
serveWorker<
  { id: number; delay?: number; fail?: boolean; crash?: boolean },
  number
>(async (task, report) => {
  report({ pid: process.pid });
  await Bun.sleep(task.delay ?? 0);
  if (task.fail) throw new Error("injected worker failure");
  if (task.crash) process.exit(7);
  return task.id;
});
