import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SourceCache } from "../apps/server/source-cache";
import {
  regionalSource,
  regionalSources,
} from "../apps/server/regional-sources";
import { verifiedSources } from "../apps/server/verified-sources";
import {
  pinnedPbfMatches,
  blockFamily,
  coversCapabilities,
} from "../packages/provisioning/src/families";

test("regional imports are visible and reusable without copying; deletion guards dependencies and leaves maps", async () => {
  const dir = await mkdtemp("/tmp/atlas-regional-");
  const key = "a".repeat(64),
    path = `${dir}/hosted/sources/${key}.osm.pbf`;
  const bytes = new TextEncoder().encode("retained Portugal fixture"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = {
    url: "https://download.geofabrik.de/europe/portugal-261028.osm.pbf",
    bytes: bytes.length,
    sha256,
    lastModified: new Date().toUTCString(),
    fetchedAt: new Date().toISOString(),
  };
  const cache = new SourceCache(dir + "/sources");
  try {
    await Bun.write(path, bytes);
    await Bun.write(path + ".source.json", JSON.stringify(receipt));
    await Bun.write(dir + "/hosted/keep.atlas", "map");
    const jobs = await cache.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("regional");
    expect((jobs[0] as any).path).toBeUndefined();
    const id = jobs[0]!.id;
    expect((await regionalSource(dir + "/sources", id)).path).toBe(path);
    expect((await verifiedSources(dir + "/sources"))[0]!.sha256).toBe(sha256);
    cache.beforeDelete = async () => {
      throw new Error("used by queued build");
    };
    await expect(cache.delete(id)).rejects.toThrow("queued build");
    expect(await Bun.file(path).exists()).toBe(true);
    cache.beforeDelete = undefined;
    await cache.delete(id);
    expect(await cache.list()).toHaveLength(0);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(dir + "/hosted/keep.atlas").text()).toBe("map");
    await expect(cache.delete("../../outside")).rejects.toThrow("not found");
  } finally {
    await cache.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("PBF ancestry requires a matching OSM input and search families retain their own pages", () => {
  const m = {
    source: {
      sha256: "a",
      inputs: [
        { url: "https://example.test/portugal.osm.pbf", sha256: "b" },
        { url: "atlas:coasts", sha256: "c" },
      ],
    },
  } as any;
  expect(pinnedPbfMatches(m, "b")).toBe(true);
  expect(pinnedPbfMatches(m, "c")).toBe(false);
  expect(pinnedPbfMatches(m, "different")).toBe(false);
  expect(blockFamily("search/street-pages/16/0/0")).toBe("reverse");
  expect(blockFamily("search/terms/8/0/0")).toBe("search");
  expect(blockFamily("features/geometry/16/0/0")).toBe("features");
  expect(blockFamily("custom/demo")).toBeUndefined();
});

test("capability donors must cover the actual selection polygon", () => {
  const full = { bounds: [0, 0, 10, 10] } as any;
  const triangle = {
    ...full,
    selection: {
      polygon: [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
    },
  };
  expect(coversCapabilities(full, triangle)).toBe(true);
  expect(coversCapabilities(triangle, full)).toBe(false);
});
