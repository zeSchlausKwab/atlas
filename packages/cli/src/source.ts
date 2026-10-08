import { open, rename, rm, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
export async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** Stream source bytes and hash them without an ArrayBuffer the size of the input. */
export async function fetchSource(
  url: string,
  out: string,
  maxBytes = 2_000_000_000,
) {
  await mkdir(dirname(out), { recursive: true });
  if (await Bun.file(out).exists()) {
    const sidecar = Bun.file(`${out}.source.json`);
    if (!(await sidecar.exists()))
      throw new Error(`Source sidecar missing: ${out}`);
    const metadata = await sidecar.json();
    if (metadata.url !== url || metadata.sha256 !== (await fileHash(out)))
      throw new Error(`Existing source does not match recipe: ${out}`);
    console.log(`Verified cached source: ${out}`);
    return metadata;
  }
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`Download failed: ${url} (HTTP ${response.status})`);
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("Source exceeds download budget");
  const part = `${out}.part`,
    file = await open(part, "w"),
    hash = createHash("sha256");
  let bytes = 0,
    next = 100_000_000;
  try {
    const stream = response.body.getReader();
    while (true) {
      const { value: chunk, done } = await stream.read();
      if (done) break;
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("Source exceeds download budget");
      hash.update(chunk);
      for (let written = 0; written < chunk.length; )
        written += (await file.write(chunk, written, chunk.length - written))
          .bytesWritten;
      if (bytes >= next) {
        console.log(
          `${out.split("/").pop()}: ${(bytes / 1e6).toFixed(0)} MB downloaded`,
        );
        next += 100_000_000;
      }
    }
    await file.close();
    await rename(part, out);
    const metadata = { url, bytes, sha256: hash.digest("hex") };
    await Bun.write(`${out}.source.json`, JSON.stringify(metadata, null, 2));
    console.log(`Downloaded ${out}: ${(bytes / 1e6).toFixed(1)} MB`);
    return metadata;
  } catch (e) {
    await file.close().catch(() => {});
    await rm(part, { force: true });
    throw e;
  }
}
