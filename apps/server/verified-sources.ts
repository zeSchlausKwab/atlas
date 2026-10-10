import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SourceJob } from "../../packages/provisioning/src/source-cache";
import type { VerifiedBuildSource } from "../../packages/provisioning/src/cached-build";
/** Resolve IDs inside the server-owned cache; clients never supply filesystem paths. */
export async function verifiedSource(
  directory: string,
  id: string,
): Promise<VerifiedBuildSource> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid cached source ID");
  const path = resolve(directory, `${id}.osm.pbf`);
  const job = (await Bun.file(
    resolve(directory, `${id}.json`),
  ).json()) as SourceJob;
  const receipt = await Bun.file(path + ".source.json").json();
  const file = await stat(path);
  if (
    job.id !== id ||
    job.state !== "ready" ||
    !job.sha256 ||
    !/^[a-f0-9]{64}$/.test(job.sha256) ||
    receipt.id !== id ||
    receipt.sha256 !== job.sha256 ||
    receipt.bytes !== job.bytes ||
    receipt.url !== job.url ||
    receipt.md5 !== job.md5 ||
    !receipt.verifiedAt ||
    file.size !== job.bytes
  )
    throw new Error("Source is not a complete, checksum-verified PBF");
  return {
    id,
    kind: job.kind,
    name: job.name,
    url: job.url,
    bytes: job.bytes,
    etag: job.etag,
    lastModified: job.lastModified,
    md5: job.md5,
    inspectedAt: job.inspectedAt,
    sha256: job.sha256,
    path,
    mtimeMs: file.mtimeMs,
  };
}
export async function verifiedSources(directory: string) {
  const sources = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    try {
      const { path, mtimeMs, ...source } = await verifiedSource(
        directory,
        name.slice(0, -5),
      );
      sources.push(source);
    } catch {
      /* Incomplete downloads aren't build inputs. */
    }
  }
  return sources;
}
