import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { registerSourceLocation } from "../apps/server/source-location";
import { verifiedSource } from "../apps/server/verified-sources";
test("external source registration verifies bytes, survives original removal, refuses altered or missing NAS files", async () => {
  const dir = await mkdtemp("/tmp/atlas-source-location-"),
    id = "a".repeat(32);
  const original = `${dir}/${id}.osm.pbf`,
    nas = `${dir}/mounted/planet.pbf`;
  const bytes = new TextEncoder().encode("verified source fixture");
  const job = {
    id,
    state: "ready",
    kind: "planet",
    name: "OSM test",
    bytes: bytes.length,
    url: "https://example.org/planet.pbf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: "b".repeat(32),
    verifiedAt: new Date().toISOString(),
  };
  try {
    await Bun.write(original, bytes);
    await Bun.write(nas, bytes);
    await Bun.write(`${dir}/${id}.json`, JSON.stringify(job));
    await Bun.write(original + ".source.json", JSON.stringify(job));
    await registerSourceLocation(dir, id, nas);
    expect((await verifiedSource(dir, id)).path).toBe(nas);
    await rm(original);
    expect((await verifiedSource(dir, id)).sha256).toBe(job.sha256);
    const bad = `${dir}/bad.pbf`;
    await Bun.write(bad, new Uint8Array(bytes.length));
    await expect(registerSourceLocation(dir, id, bad)).rejects.toThrow(
      "checksum",
    );
    expect((await verifiedSource(dir, id)).path).toBe(nas);
    await expect(registerSourceLocation(dir, "../x", nas)).rejects.toThrow(
      "ID",
    );
    await expect(
      registerSourceLocation(dir, id, "/etc/passwd"),
    ).rejects.toThrow("Source path");
    await Bun.write(nas, "changed");
    await expect(verifiedSource(dir, id)).rejects.toThrow("verified");
    await rm(nas);
    await expect(verifiedSource(dir, id)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
