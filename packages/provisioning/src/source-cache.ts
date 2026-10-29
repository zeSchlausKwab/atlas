import { DISK_RESERVE } from "./capacity";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export type SourceFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
export const SOURCE_RESERVE = DISK_RESERVE;
// Bound network read-ahead even on runtimes that do not propagate stream backpressure.
export const SOURCE_RANGE_BYTES = 16 * 1024 ** 2;
export class RetryableSourceError extends Error {}
export type SourceKind = "planet" | "europe" | "regional";
export interface CachedSource {
  id: string;
  kind: SourceKind;
  name: string;
  url: string;
  bytes: number;
  etag: string;
  lastModified: string;
  md5: string;
  inspectedAt: string;
}
export interface SourceJob extends CachedSource {
  allowStorageRisk?: boolean;
  state:
    | "waiting"
    | "queued"
    | "downloading"
    | "retrying"
    | "verifying"
    | "paused"
    | "failed"
    | "ready";
  completed: number;
  updatedAt: string;
  message: string;
  sha256?: string;
  error?: string;
}
export function trustedSourceUrl(value: string, checksum = false) {
  const u = new URL(value);
  const end = checksum ? "\\.osm\\.pbf(?:\\.md5)?" : "\\.osm\\.pbf";
  const planet =
    u.hostname === "planet.openstreetmap.org" &&
    new RegExp(`^/pbf/planet-(?:latest|\\d{6})${end}$`).test(u.pathname);
  const mirror =
    u.hostname ===
      "osm-planet-eu-central-1.s3.dualstack.eu-central-1.amazonaws.com" &&
    new RegExp(`^/planet/pbf/\\d{4}/planet-\\d{6}${end}$`).test(u.pathname);
  const europe =
    u.hostname === "download.geofabrik.de" &&
    new RegExp(`^/europe-(?:latest|\\d{6})${end}$`).test(u.pathname);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !(planet || mirror || europe)
  )
    throw new Error("Untrusted source URL");
  return u.href;
}
export async function inspectSource(
  kind: SourceKind,
  fetcher: SourceFetch = fetch,
): Promise<CachedSource> {
  if (!["planet", "europe"].includes(kind))
    throw new Error("Choose Planet or Europe");
  let url =
    kind === "planet"
      ? "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf"
      : "https://download.geofabrik.de/europe-latest.osm.pbf";
  let response: Response | undefined;
  for (let i = 0; i < 5; i++) {
    response = await fetcher(trustedSourceUrl(url), {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    url = trustedSourceUrl(
      new URL(response.headers.get("location") ?? "", url).href,
    );
  }
  if (!response?.ok || !/-\d{6}\.osm\.pbf$/.test(url))
    throw new Error("Source must resolve to an immutable dated PBF");
  const bytes = Number(response.headers.get("content-length")),
    etag = response.headers.get("etag"),
    lastModified = response.headers.get("last-modified");
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    !etag ||
    etag.startsWith("W/") ||
    !lastModified
  )
    throw new Error("Source lacks resumable size/identity metadata");
  const checksum = await fetcher(trustedSourceUrl(url + ".md5", true), {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!checksum.ok) throw new Error(`Source checksum: HTTP ${checksum.status}`);
  const body = await checksum.text();
  if (body.length > 1024 || !/^[a-f0-9]{32}\s/i.test(body))
    throw new Error("Invalid published MD5 checksum");
  const md5 = body.slice(0, 32).toLowerCase();
  return {
    id: createHash("sha256")
      .update(JSON.stringify([url, bytes, etag, md5]))
      .digest("hex")
      .slice(0, 32),
    kind,
    name: kind === "planet" ? "OSM planet" : "OSM Europe",
    url,
    bytes,
    etag,
    lastModified,
    md5,
    inspectedAt: new Date().toISOString(),
  };
}
export async function partialSize(path: string) {
  return (await stat(path).catch(() => undefined))?.size ?? 0;
}
/** Append only when the remote confirms the exact range AND pinned identity. */
export function validateSourceResponse(
  response: Response,
  source: CachedSource,
  offset: number,
  end = source.bytes - 1,
) {
  if (response.headers.get("etag") !== source.etag)
    throw new Error("Source identity changed; inspect a new source");
  const wholeFile = offset === 0 && end === source.bytes - 1;
  if (response.status !== 206 && !(wholeFile && response.status === 200))
    throw new Error(`Source download: HTTP ${response.status}; expected 206`);
  if (
    Number(response.headers.get("content-length")) !== end - offset + 1 ||
    (response.status === 206 &&
      response.headers.get("content-range") !==
        `bytes ${offset}-${end}/${source.bytes}`)
  )
    throw new Error(
      "Invalid resume range or source size; partial file was not appended",
    );
}
export async function cacheSource(
  source: CachedSource,
  directory: string,
  signal: AbortSignal,
  report: (
    state: "downloading" | "verifying",
    completed: number,
  ) => Promise<void>,
  fetcher: SourceFetch = fetch,
) {
  const path = join(directory, source.id + ".osm.pbf"),
    part = path + ".part";
  await mkdir(directory, { recursive: true });
  const alreadyPublished = (await partialSize(path)) === source.bytes;
  let offset = alreadyPublished ? source.bytes : await partialSize(part);
  if (offset > source.bytes)
    throw new Error("Partial file exceeds source size");
  signal.throwIfAborted();
  let lastReport = 0;
  while (offset < source.bytes) {
    signal.throwIfAborted();
    const end = Math.min(source.bytes - 1, offset + SOURCE_RANGE_BYTES - 1);
    const controller = new AbortController(),
      stop = () => controller.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    let timer = setTimeout(
      () => controller.abort(new Error("Source connection timed out")),
      30000,
    );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(source.url, {
        redirect: "error",
        headers: {
          "If-Match": source.etag,
          "Accept-Encoding": "identity",
          Range: `bytes=${offset}-${end}`,
        },
        signal: controller.signal,
      }).catch((error) => {
        signal.throwIfAborted();
        throw new RetryableSourceError(
          `Source connection failed: ${String(error)}`,
        );
      });
      clearTimeout(timer);
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        throw new RetryableSourceError(
          `Source temporarily unavailable: HTTP ${response.status}`,
        );
      }
      try {
        validateSourceResponse(response, source, offset, end);
      } catch (e) {
        await response.body?.cancel();
        throw e;
      }
      if (!response.body) throw new Error("Empty source response");
      file = await open(part, offset ? "a" : "w");
      reader = response.body.getReader();
      if (!lastReport) {
        await report("downloading", offset);
        lastReport = performance.now();
      }
      while (true) {
        signal.throwIfAborted();
        timer = setTimeout(
          () => controller.abort(new Error("Source stalled for two minutes")),
          120000,
        );
        const { done, value } = await reader.read().catch((error) => {
          signal.throwIfAborted();
          throw new RetryableSourceError(
            `Source connection interrupted: ${String(error)}`,
          );
        });
        clearTimeout(timer);
        if (done) break;
        if (offset + value.length > end + 1)
          throw new Error("Source exceeded its requested range");
        for (let at = 0; at < value.length; ) {
          const written = (await file.write(value, at, value.length - at))
            .bytesWritten;
          if (!written) throw new Error("No disk write progress");
          at += written;
        }
        offset += value.length;
        if (performance.now() - lastReport > 1500 || offset === source.bytes) {
          await report("downloading", offset);
          lastReport = performance.now();
        }
      }
      if (offset !== end + 1)
        throw new RetryableSourceError(
          "Source connection ended early; partial download retained",
        );
      if (offset === source.bytes) await file.sync();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      await reader?.cancel().catch(() => {});
      await file?.close();
    }
  }
  await report("verifying", 0);
  const md5 = createHash("md5"),
    sha = createHash("sha256");
  let verified = 0,
    last = performance.now();
  for await (const chunk of createReadStream(alreadyPublished ? path : part)) {
    signal.throwIfAborted();
    md5.update(chunk);
    sha.update(chunk);
    verified += chunk.length;
    if (performance.now() - last > 1500) {
      await report("verifying", verified);
      last = performance.now();
    }
  }
  if (verified !== source.bytes || md5.digest("hex") !== source.md5) {
    if (!alreadyPublished) await rm(part, { force: true });
    throw new Error(
      "Published checksum mismatch; corrupt partial removed. Resume to download again.",
    );
  }
  signal.throwIfAborted();
  const sha256 = sha.digest("hex");
  await Bun.write(
    path + ".source.json.tmp",
    JSON.stringify(
      { ...source, sha256, verifiedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  await rename(path + ".source.json.tmp", path + ".source.json");
  if (!alreadyPublished) await rename(part, path);
  return { path, sha256 };
}

/** Retry only interrupted transfers; identity, checksum and disk failures need attention. */
export async function cacheSourceWithRetries(
  source: CachedSource,
  directory: string,
  signal: AbortSignal,
  report: (
    state: "downloading" | "verifying" | "retrying",
    completed: number,
    message?: string,
  ) => Promise<void>,
  fetcher: SourceFetch = fetch,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = async (
    ms,
    signal,
  ) => {
    await delay(ms, undefined, { signal });
  },
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await cacheSource(source, directory, signal, report, fetcher);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RetryableSourceError) || attempt >= 5) throw error;
      const ms = Math.min(5000 * 2 ** attempt, 60000);
      await report(
        "retrying",
        await partialSize(join(directory, source.id + ".osm.pbf.part")),
        `${error.message}. Retrying from saved bytes in ${ms / 1000}s (${attempt + 1}/5).`,
      );
      await wait(ms, signal);
    }
  }
}
