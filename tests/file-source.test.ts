import { test, expect } from "bun:test";
import { mkdtemp, rename, rm, open } from "node:fs/promises";
import { PackageSource } from "../apps/server/package-source";
import { servePackage } from "../apps/server/ranges";
test("pinned file ranges survive path replacement and concurrent reads; full downloads stream", async () => {
  const dir = await mkdtemp("/tmp/atlas-file-");
  let source: PackageSource | undefined;
  try {
    const bytes = Uint8Array.from({ length: 180000 }, (_, i) => i % 251);
    await Bun.write(`${dir}/map`, bytes);
    source = await PackageSource.open(`${dir}/map`);
    await Bun.write(`${dir}/next`, new Uint8Array(bytes.length).fill(7));
    await rename(`${dir}/next`, `${dir}/map`);
    const pieces = await Promise.all(
      [
        [3, 13],
        [99000, 100000],
        [0, 32],
      ].map(([s, e]) => source!.read(s!, e!)),
    );
    expect(pieces[0]).toEqual(bytes.slice(3, 13));
    expect(pieces[1]).toEqual(bytes.slice(99000, 100000));
    const request = new Request("http://localhost/maps/demo.atlas", {
      headers: { Range: "bytes=65530-65540", "If-Match": source.etag },
    });
    const response = servePackage(request, source, source.etag);
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      bytes.slice(65530, 65541),
    );
    const full = servePackage(
      new Request("http://localhost/maps/demo.atlas"),
      source,
      source.etag,
    );
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    const next = await PackageSource.open(`${dir}/map`);
    expect(next.etag).not.toBe(source.etag);
    await next.close();
  } finally {
    await source?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("in-place mutation fails instead of mixing archive versions", async () => {
  const dir = await mkdtemp("/tmp/atlas-mutation-");
  let source: PackageSource | undefined;
  try {
    await Bun.write(`${dir}/map`, new Uint8Array(32));
    source = await PackageSource.open(`${dir}/map`);
    const handle = await open(`${dir}/map`, "r+");
    await handle.truncate(8);
    await handle.close();
    await expect(source.read(0, 16)).rejects.toThrow("modified in place");
  } finally {
    await source?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
