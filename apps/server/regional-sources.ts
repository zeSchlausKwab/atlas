import { readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SourceJob } from "../../packages/provisioning/src/source-cache";
import type { VerifiedBuildSource } from "../../packages/provisioning/src/cached-build";
import { allowedPbfUrl } from "../../packages/provisioning/src/global-source";
/** Regional imports already retain these bytes. Include old and current cache locations. */
export async function regionalSources(directory: string) {
  const found: {
    job: SourceJob;
    source: VerifiedBuildSource;
    receiptPath: string;
  }[] = [];
  for (const cache of [
    join(directory, "regional"),
    resolve(directory, "../hosted/sources"),
  ]) {
    for (const name of await readdir(cache).catch(() => [])) {
      if (!/^[a-f0-9]{64}\.osm\.pbf\.source\.json$/.test(name)) continue;
      try {
        const receiptPath = join(cache, name),
          path = receiptPath.slice(0, -12);
        const r = await Bun.file(receiptPath).json(),
          f = await stat(path);
        if (
          !f.isFile() ||
          f.size !== r.bytes ||
          !/^[a-f0-9]{64}$/.test(r.sha256)
        )
          continue;
        const url = allowedPbfUrl(r.url),
          id = "regional-" + name.slice(0, 64);
        const region = new URL(url).pathname
          .split("/")
          .at(-1)!
          .replace(/-(?:latest|\d{6})\.osm\.pbf$/, "");
        const source: VerifiedBuildSource = {
          id,
          kind: "regional",
          name: region[0]!.toUpperCase() + region.slice(1),
          url,
          bytes: r.bytes,
          etag: r.etag ?? "",
          lastModified: r.lastModified,
          md5: "",
          inspectedAt: r.fetchedAt,
          sha256: r.sha256,
          path,
          mtimeMs: f.mtimeMs,
        };
        if (!found.some((v) => v.source.id === id))
          found.push({
            source,
            receiptPath,
            job: {
              ...source,
              state: "ready",
              completed: r.bytes,
              updatedAt: r.fetchedAt,
              message: "Retained regional PBF; SHA-256 verified during import",
            },
          });
      } catch {
        /* Incomplete or missing imports are not reusable sources. */
      }
    }
  }
  return found;
}
export async function regionalSource(directory: string, id: string) {
  if (!/^regional-[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid regional source ID");
  const value = (await regionalSources(directory)).find(
    (v) => v.source.id === id,
  );
  if (!value)
    throw new Error(
      "Retained regional PBF is missing; download the pinned source again.",
    );
  return value.source;
}
export async function deleteRegionalSource(directory: string, id: string) {
  await regionalSource(directory, id);
  // Remove every managed copy of this cache key; never follow external NAS locations.
  const key = id.slice(9);
  for (const cache of [
    join(directory, "regional"),
    resolve(directory, "../hosted/sources"),
  ])
    for (const suffix of [".osm.pbf", ".osm.pbf.source.json"])
      await rm(join(cache, key + suffix), { force: true });
}
