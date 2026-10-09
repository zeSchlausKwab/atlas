import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileHash } from "../../cli/src/source";
import { allowedPbfUrl, type PbfPlan } from "./global-source";
export type SourceFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
export interface SourceReceipt {
  url: string;
  bytes: number;
  sha256: string;
  lastModified: string;
  etag?: string;
  fetchedAt: string;
}
export async function downloadPbf(
  plan: PbfPlan,
  directory: string,
  signal: AbortSignal,
  progress: (bytes: number, cached: boolean) => void,
  fetcher: SourceFetch = fetch,
) {
  const url = allowedPbfUrl(plan.region.url);
  const key = createHash("sha256")
      .update(JSON.stringify([url, plan.etag, plan.lastModified, plan.bytes]))
      .digest("hex"),
    path = join(directory, key + ".osm.pbf");
  await mkdir(directory, { recursive: true });
  signal.throwIfAborted();
  if (
    (await Bun.file(path).exists()) &&
    (await Bun.file(path + ".source.json").exists())
  ) {
    const receipt = (await Bun.file(
      path + ".source.json",
    ).json()) as SourceReceipt;
    if (
      receipt.url === url &&
      receipt.bytes === plan.bytes &&
      Bun.file(path).size === plan.bytes &&
      (await fileHash(path)) === receipt.sha256
    ) {
      signal.throwIfAborted();
      progress(plan.bytes, true);
      return { path, receipt, cached: true };
    }
    throw new Error(
      "Cached PBF identity failed verification. Remove that cached source and retry.",
    );
  }
  const headers: Record<string, string> = {
    "Accept-Encoding": "identity",
    ...(plan.etag
      ? { "If-Match": plan.etag }
      : { "If-Unmodified-Since": plan.lastModified }),
  };
  const response = await fetcher(url, { headers, redirect: "error", signal });
  if (response.status === 412)
    throw new Error("PBF changed since planning. Check the source again.");
  if (!response.ok || !response.body)
    throw new Error(`PBF download failed: HTTP ${response.status}`);
  const changed =
    Number(response.headers.get("content-length")) !== plan.bytes ||
    (plan.etag
      ? response.headers.get("etag") !== plan.etag
      : response.headers.get("last-modified") !== plan.lastModified);
  if (changed) {
    await response.body.cancel();
    throw new Error(
      "PBF identity or size changed since planning. Check the source again.",
    );
  }
  const part = path + ".part",
    file = await open(part, "w"),
    hash = createHash("sha256"),
    reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > plan.bytes || size > plan.area.maxSourceBytes)
        throw new Error("PBF exceeded the source download budget");
      hash.update(value);
      for (let written = 0; written < value.length; ) {
        const n = (await file.write(value, written, value.length - written))
          .bytesWritten;
        if (!n) throw new Error("PBF disk write made no progress");
        written += n;
      }
      progress(size, false);
    }
    if (size !== plan.bytes) throw new Error("PBF download was truncated");
    signal.throwIfAborted();
    await file.close();
    await rename(part, path);
    const receipt: SourceReceipt = {
      url,
      bytes: size,
      sha256: hash.digest("hex"),
      lastModified: plan.lastModified,
      etag: plan.etag,
      fetchedAt: new Date().toISOString(),
    };
    await Bun.write(path + ".source.json.tmp", JSON.stringify(receipt));
    await rename(path + ".source.json.tmp", path + ".source.json");
    return { path, receipt, cached: false };
  } catch (e) {
    await file.close().catch(() => {});
    await rm(part, { force: true });
    throw e;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
