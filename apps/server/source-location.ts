import { open, rename, stat, writeFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createHash } from "node:crypto";
export interface SourceLocation {
  version: 1;
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  mtimeMs: number;
  verifiedAt: string;
}
export async function registerSourceLocation(
  directory: string,
  id: string,
  input: string,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid source ID");
  const path = resolve(input);
  const roots = (
    process.env.ATLAS_SOURCE_ROOTS ??
    `${directory},/mnt,/media,/run/user/${process.getuid?.() ?? 1000}/gvfs`
  )
    .split(",")
    .map((p) => resolve(p.trim()));
  if (!roots.some((r) => path.startsWith(r + sep)))
    throw new Error(
      "Source path must be within ATLAS_SOURCE_ROOTS or a mounted /mnt, /media or user GVFS share",
    );
  const job = await Bun.file(join(directory, id + ".json")).json();
  const receipt = await Bun.file(
    join(directory, id + ".osm.pbf.source.json"),
  ).json();
  if (
    job.state !== "ready" ||
    job.sha256 !== receipt.sha256 ||
    job.bytes !== receipt.bytes
  )
    throw new Error("Choose an already verified source");
  const progressFile = join(directory, id + ".location-progress.json");
  const progress = async (
    state: string,
    completed: number,
    message: string,
  ) => {
    await writeFile(
      progressFile + ".tmp",
      JSON.stringify({
        id,
        state,
        path,
        completed,
        bytes: job.bytes,
        message,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }),
    );
    await rename(progressFile + ".tmp", progressFile);
  };
  const f = await open(path, "r");
  try {
    const before = await f.stat();
    if (!before.isFile() || before.size !== job.bytes)
      throw new Error("Source size does not match the verified PBF");
    const hash = createHash("sha256"),
      buffer = new Uint8Array(4 * 1024 ** 2);
    let done = 0,
      reported = 0;
    await progress(
      "verifying",
      done,
      "Verifying source at the new location. The original is retained.",
    );
    while (done < job.bytes) {
      signal?.throwIfAborted();
      const r = await f.read(
        buffer,
        0,
        Math.min(buffer.length, job.bytes - done),
        done,
      );
      if (!r.bytesRead) throw new Error("Truncated source");
      hash.update(buffer.subarray(0, r.bytesRead));
      done += r.bytesRead;
      if (Date.now() - reported > 2000) {
        await progress(
          "verifying",
          done,
          "Verifying SHA-256 at the new location…",
        );
        reported = Date.now();
      }
    }
    const after = await f.stat(),
      current = await stat(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.mtimeMs !== before.mtimeMs ||
      hash.digest("hex") !== job.sha256
    )
      throw new Error("Source changed or checksum does not match");
    const location: SourceLocation = {
      version: 1,
      id,
      path,
      bytes: job.bytes,
      sha256: job.sha256,
      mtimeMs: after.mtimeMs,
      verifiedAt: new Date().toISOString(),
    };
    const target = join(directory, id + ".location.json");
    await writeFile(target + ".tmp", JSON.stringify(location));
    await rename(target + ".tmp", target);
    await progress(
      "ready",
      done,
      "Verified external source registered. The original can now be removed after a read check.",
    );
    return location;
  } catch (e) {
    await progress("failed", 0, String(e));
    throw e;
  } finally {
    await f.close();
  }
}
