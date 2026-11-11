import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileHash } from "../../cli/src/source";
import { runCompiler } from "./process";
import type { VerifiedBuildSource } from "./cached-build";
import type { PackageSelection } from "./selection";
import { isWorldSelection } from "./world-selection";

// A shared superset for the two low-zoom world recipes. Osmium includes relation
// members and way nodes; never use --omit-referenced here. Exact boundary detail
// and original OSM IDs are preserved. Administrative depth is applied later.
export const WORLD_INPUT_FILTERS = [
  "n/place",
  "wr/natural=water",
  "wr/landuse=reservoir",
  "w/waterway",
  "r/waterway=riverbank",
  "wr/boundary=administrative",
] as const;
export function usesWorldInput(s: PackageSelection) {
  return (
    isWorldSelection(s.polygon) &&
    s.maxZoom <= 6 &&
    s.layers.every((l) => l === "water") &&
    s.featureKinds.every((k) => k === "boundaries") &&
    !s.profiles.length &&
    !s.search &&
    !s.reverse &&
    !s.peaks &&
    !s.streetNames &&
    !s.pois
  );
}
export async function prepareWorldInput(
  source: VerifiedBuildSource,
  cache: string,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const identity = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        version: 1,
        source: source.sha256,
        filters: WORLD_INPUT_FILTERS,
      }),
    )
    .digest("hex");
  const directory = join(cache, identity),
    path = join(directory, "world.osm.pbf"),
    receipt = join(directory, "receipt.json"),
    partial = join(directory, "world.part.osm.pbf");
  await mkdir(directory, { recursive: true });
  // Host preparations are serialized. An exclusive lock also rejects accidental
  // parallel CLI writers; a crashed worker's lock is recoverable by its PID.
  const lock = join(directory, "writer.json");
  if (await Bun.file(lock).exists()) {
    const owner = (await Bun.file(lock).json()) as { pid: number };
    if (!Number.isInteger(owner.pid) || owner.pid <= 0)
      throw new Error("Invalid world-input writer lock");
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive)
      throw new Error("Another worker is preparing this shared world input");
    await rm(lock);
  }
  const { open } = await import("node:fs/promises");
  const handle = await open(lock, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    if (await Bun.file(receipt).exists()) {
      const saved = (await Bun.file(receipt).json()) as {
        identity: string;
        bytes: number;
        sha256: string;
      };
      progress("Verifying shared world input: boundaries, places and water");
      if (
        saved.identity !== identity ||
        (await stat(path)).size !== saved.bytes ||
        (await fileHash(path, undefined, signal)) !== saved.sha256
      )
        throw new Error(
          "Shared world input changed; remove this derived cache before retrying",
        );
      return path;
    }
    progress(
      "Filtering the planet to boundaries, places and water (retaining referenced geometry)",
    );
    await runCompiler(
      [
        "osmium",
        "tags-filter",
        source.path,
        ...WORLD_INPUT_FILTERS,
        "--overwrite",
        "--progress",
        "-o",
        partial,
      ],
      directory,
      signal,
      progress,
    );
    await runCompiler(
      ["osmium", "check-refs", partial],
      directory,
      signal,
      progress,
    );
    const sha256 = await fileHash(partial, undefined, signal),
      bytes = (await stat(partial)).size;
    signal.throwIfAborted();
    await rename(partial, path);
    await Bun.write(
      receipt + ".part",
      JSON.stringify({
        identity,
        bytes,
        sha256,
        source: source.sha256,
        filters: WORLD_INPUT_FILTERS,
      }),
    );
    await rename(receipt + ".part", receipt);
    progress(`Shared world input ready: ${(bytes / 1024 ** 3).toFixed(2)} GiB`);
    return path;
  } finally {
    await handle.close();
    await rm(partial, { force: true });
    await rm(lock, { force: true });
  }
}
