import { open, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileHash } from "../../cli/src/source";
/** Publish across volumes without exposing a partial package or discarding its source. */
export async function publishPrepared(
  source: string,
  output: string,
  signal: AbortSignal,
  progress: (done: number, total: number) => void = () => {},
) {
  signal.throwIfAborted();
  if ((await stat(source)).dev === (await stat(dirname(output))).dev) {
    await rename(source, output);
    return;
  }
  const partial = output + ".part",
    total = (await stat(source)).size,
    hash = createHash("sha256");
  let done = 0,
    reported = 0;
  progress(0, total * 2);
  try {
    await pipeline(
      createReadStream(source, { highWaterMark: 4 * 1024 ** 2 }),
      new Transform({
        transform(chunk, _e, next) {
          hash.update(chunk);
          done += chunk.length;
          if (Date.now() - reported > 500) {
            progress(done, total * 2);
            reported = Date.now();
          }
          next(null, chunk);
        },
      }),
      createWriteStream(partial, { flags: "w" }),
      { signal },
    );
    const fd = await open(partial, "r+");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (
      (await fileHash(
        partial,
        (n) => progress(total + n, total * 2),
        signal,
      )) !== hash.digest("hex")
    )
      throw Error("Final package copy checksum mismatch");
    signal.throwIfAborted();
    await rename(partial, output);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
}
