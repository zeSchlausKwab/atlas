#!/usr/bin/env bun
/** Read-only progress bridge: adds visibility to an already-running legacy compiler. */
import { readdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CompilerObserver } from "../apps/server/compiler-observer";
import type { PreparationJob } from "../apps/server/preparations";
const [directoryArg, outputArg, mode] = process.argv.slice(2);
if (!directoryArg || !outputArg)
  throw new Error(
    "Usage: bun scripts/observe-compilation.ts HOSTED_DIRECTORY OUTPUT_JSON [--once]",
  );
const directory = resolve(directoryArg),
  output = resolve(outputArg),
  observers = new Map<string, CompilerObserver>();
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
do {
  let pending = 0;
  const observations = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const job = (await Bun.file(join(directory, name))
      .json()
      .catch(() => undefined)) as PreparationJob | undefined;
    if (!job) continue;
    if (["running", "cancelling", "queued"].includes(job.state)) pending++;
    if (!["running", "cancelling"].includes(job.state)) continue;
    let observer = observers.get(job.id);
    if (!observer) {
      observer = new CompilerObserver();
      observers.set(job.id, observer);
    }
    const sample = await observer.sample(job, directory).catch((error) => {
      console.error(String(error));
      return undefined;
    });
    if (sample) observations.push(sample);
  }
  await Bun.write(
    output + ".part",
    JSON.stringify({ schema: 1, observations }),
  );
  await rename(output + ".part", output);
  if (!pending || mode === "--once") break;
  await Bun.sleep(15000);
} while (!stopped);
