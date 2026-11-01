/** Park inactive compiler files; the marker blocks compilation until verified restore. */
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
export const PARKING_MARKER = "checkpoint-parked.json";
export interface ParkingState {
  version: 1;
  work: string;
  archive: string;
  phase: "copying" | "verifying" | "parked" | "restoring" | "error";
  file?: string;
  completed: number;
  total: number;
  updatedAt: string;
  error?: string;
  files: Array<{
    name: string;
    bytes: number;
    mtimeMs: number;
    sha256?: string;
    removed?: boolean;
  }>;
}
export async function readParking(
  work: string,
): Promise<ParkingState | undefined> {
  const file = Bun.file(resolve(work, PARKING_MARKER));
  return (await file.exists()) ? await file.json() : undefined;
}
export async function assertCheckpointsLocal(work: string) {
  if (await Bun.file(resolve(work, PARKING_MARKER)).exists())
    throw new Error(
      "Checkpoints are parked on external storage or being transferred. Restore them to the SSD before resuming this build.",
    );
}
function child(root: string, name: string) {
  if (
    !name ||
    isAbsolute(name) ||
    name.split(/[\\/]/).some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid checkpoint filename");
  return resolve(root, name);
}
async function saveGuard(work: string, value: string) {
  const target = resolve(work, PARKING_MARKER);
  const file = await open(target + ".tmp", "w", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(target + ".tmp", target);
  const directory = await open(work, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function digest(path: string, progress: (bytes: number) => void) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 8 * 1024 * 1024,
  })) {
    hash.update(chunk);
    bytes += chunk.length;
    progress(bytes);
  }
  return hash.digest("hex");
}
async function copy(
  path: string,
  to: string,
  progress: (bytes: number) => void,
) {
  const hash = createHash("sha256");
  let bytes = 0;
  await mkdir(dirname(to), { recursive: true });
  await pipeline(
    createReadStream(path, { highWaterMark: 8 * 1024 * 1024 }),
    new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        progress(bytes);
        done(null, chunk);
      },
    }),
    createWriteStream(to, { flags: "w", mode: 0o600 }),
  );
  const fd = await open(to, "r+");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  return hash.digest("hex");
}
/** The caller must stop the job first; checkIdle runs again after the guard marker exists. */
export async function parkCheckpoints(options: {
  work: string;
  archive: string;
  files: string[];
  checkIdle: () => Promise<void>;
  progress?: (state: ParkingState) => void;
}) {
  const work = await realpath(options.work);
  await mkdir(options.archive, { recursive: true });
  const archive = await realpath(options.archive);
  if (
    !relative(work, archive).startsWith("..") ||
    !relative(archive, work).startsWith("..")
  )
    throw new Error("Archive and workspace must be separate directories");
  const lock = await open(resolve(work, "checkpoint-parking.lock"), "wx");
  let state: ParkingState | undefined;
  let pending = Promise.resolve();
  const save = () => {
    const value = JSON.stringify(state);
    pending = pending.then(() => saveGuard(work, value));
    return pending;
  };
  let last = 0;
  const report = (completed: number) => {
    state!.completed = completed;
    state!.updatedAt = new Date().toISOString();
    if (Date.now() - last > 2000) {
      last = Date.now();
      options.progress?.(structuredClone(state!));
      void save().catch(() => {});
    }
  };
  try {
    await options.checkIdle();
    state = await readParking(work);
    if (
      state &&
      (state.work !== work ||
        state.archive !== archive ||
        JSON.stringify(state.files.map((f) => f.name)) !==
          JSON.stringify(options.files))
    )
      throw new Error("Parking manifest belongs to another transfer");
    if (!state) {
      const files = [];
      for (const name of options.files) {
        const path = child(work, name),
          s = await lstat(path);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          (await realpath(path)) !== path
        )
          throw new Error("Checkpoint must be an ordinary local file");
        if (await Bun.file(child(archive, name)).exists())
          throw new Error(
            "Archive already contains a checkpoint; choose an empty destination",
          );
        files.push({ name, bytes: s.size, mtimeMs: s.mtimeMs });
      }
      if (!files.length) throw new Error("No checkpoints selected");
      const space = await statfs(archive);
      if (
        space.bavail * space.bsize <
        files.reduce((n, f) => n + f.bytes, 0) + 1024 ** 3
      )
        throw new Error("Archive volume has insufficient free space");
      state = {
        version: 1,
        work,
        archive,
        phase: "copying",
        completed: 0,
        total: 0,
        updatedAt: new Date().toISOString(),
        files,
      };
      await save();
    }
    await options.checkIdle();
    for (const file of state.files) {
      const source = child(work, file.name),
        dest = child(archive, file.name);
      state.file = file.name;
      state.total = file.bytes;
      state.completed = 0;
      delete state.error;
      if (file.sha256 && (await Bun.file(dest).exists())) {
        state.phase = "verifying";
        await save();
        if ((await digest(dest, report)) !== file.sha256)
          throw new Error("Archived checkpoint checksum mismatch");
      } else {
        const before = await lstat(source);
        if (
          !before.isFile() ||
          before.size !== file.bytes ||
          before.mtimeMs !== file.mtimeMs
        )
          throw new Error("Source checkpoint changed since parking began");
        state.phase = "copying";
        await save();
        const hash = await copy(source, dest + ".part", report);
        state.phase = "verifying";
        state.completed = 0;
        await save();
        if ((await digest(dest + ".part", report)) !== hash)
          throw new Error("Copied checkpoint checksum mismatch");
        const after = await lstat(source);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw new Error("Checkpoint changed during copy");
        await rename(dest + ".part", dest);
        file.sha256 = hash;
        await save();
        await Bun.write(
          resolve(archive, "parking-manifest.json"),
          JSON.stringify(state, null, 2),
        );
      }
      await options.checkIdle();
      // A crash after unlink is recoverable: the durable manifest already contains the archive hash.
      if (!file.removed) {
        const original = await lstat(source).catch((e) => {
          if (e.code === "ENOENT") return undefined;
          throw e;
        });
        if (
          original &&
          (original.size !== file.bytes || original.mtimeMs !== file.mtimeMs)
        )
          throw new Error("Source changed before reclaiming space");
        if (original) await unlink(source);
        file.removed = true;
        await save();
      }
    }
    state.phase = "parked";
    state.completed = state.total;
    delete state.error;
    await save();
    await Bun.write(
      resolve(archive, "parking-manifest.json"),
      JSON.stringify(state, null, 2),
    );
    options.progress?.(state);
    return state;
  } catch (e) {
    if (state) {
      state.phase = "error";
      state.error = String(e);
      await save().catch(() => {});
    }
    throw e;
  } finally {
    await pending.catch(() => {});
    await lock.close();
    await unlink(resolve(work, "checkpoint-parking.lock"));
  }
}
export async function restoreCheckpoints(
  work: string,
  checkIdle: () => Promise<void>,
  reserveBytes = 12 * 1024 ** 3,
) {
  work = await realpath(work);
  const lock = await open(resolve(work, "checkpoint-parking.lock"), "wx");
  try {
    await checkIdle();
    const state = await readParking(work);
    if (!state || state.work !== work)
      throw new Error("No matching parking manifest");
    let missingBytes = 0;
    for (const file of state.files) {
      if (!(await Bun.file(child(work, file.name)).exists()))
        missingBytes += file.bytes;
    }
    const space = await statfs(work);
    if (space.bavail * space.bsize < missingBytes + reserveBytes)
      throw new Error(
        "Insufficient SSD space to restore checkpoints and retain the reserve",
      );
    for (const file of state.files) {
      const dest = child(work, file.name);
      if (!file.sha256) {
        const local = await lstat(dest);
        if (local.size !== file.bytes || local.mtimeMs !== file.mtimeMs)
          throw new Error("Unarchived checkpoint changed");
        continue;
      }
      if (await Bun.file(dest).exists()) {
        if ((await digest(dest, () => {})) !== file.sha256)
          throw new Error("Local checkpoint conflicts with archive");
        continue;
      }
      const hash = await copy(
        child(state.archive, file.name),
        dest + ".restore-part",
        () => {},
      );
      if (
        hash !== file.sha256 ||
        (await digest(dest + ".restore-part", () => {})) !== file.sha256
      )
        throw new Error("Restored checkpoint checksum mismatch");
      await rename(dest + ".restore-part", dest);
    }
    await rm(resolve(work, PARKING_MARKER));
  } finally {
    await lock.close();
    await unlink(resolve(work, "checkpoint-parking.lock"));
  }
}
