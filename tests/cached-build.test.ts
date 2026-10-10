import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  BuildCheckpoints,
  cachedSourceDate,
  planCachedBuild,
  ownsDetailTile,
  DETAIL_PARTITION_ZOOM,
} from "../packages/provisioning/src/cached-build";
import {
  verifiedSource,
  verifiedSources,
} from "../apps/server/verified-sources";
import { WORLD_SOURCE } from "../packages/provisioning/src/global-source";
import type { PackageSelection } from "../packages/provisioning/src/selection";
const selection: PackageSelection = {
  snapshot: WORLD_SOURCE.snapshot,
  name: "Vienna–Bratislava",
  polygon: [
    [16.18, 47.98],
    [17.28, 47.98],
    [17.28, 48.32],
    [16.18, 48.32],
  ],
  minZoom: 0,
  maxZoom: 16,
  layers: ["land", "water", "roads", "railways", "buildings", "peaks"],
  profiles: ["walking", "cycling", "driving"],
  placeNames: true,
  streetNames: true,
  pois: true,
  search: true,
  reverse: true,
  peaks: true,
  featureKinds: ["land", "water", "roads", "railways", "buildings"],
  paddingCells: 1,
  maxBytes: 8 * 1024 ** 3,
};
test("regional plan has exclusive detail-tile ownership across every partition seam", () => {
  const plan = planCachedBuild(selection);
  expect(plan.partitions.length).toBeGreaterThan(1);
  expect(plan.candidateTiles).toBeLessThan(100000);
  for (const part of plan.partitions)
    for (const z of [12, 13, 16]) {
      const n = 2 ** (z - DETAIL_PARTITION_ZOOM);
      for (const dx of [0, n - 1])
        for (const dy of [0, n - 1]) {
          const key = `tile/water/${z}/${part.x * n + dx}/${part.y * n + dy}`;
          expect(plan.partitions.filter((p) => ownsDetailTile(key, p))).toEqual(
            [part],
          );
        }
      expect(ownsDetailTile("routing/driving/cells/14/100/100", part)).toBe(
        false,
      );
      expect(
        ownsDetailTile(`tile/water/11/${part.x * 4}/${part.y * 4}`, part),
      ).toBe(false);
    }
  expect(() =>
    planCachedBuild({
      ...selection,
      polygon: [
        [-32, 30],
        [46, 30],
        [46, 81],
        [-32, 81],
      ],
    }),
  ).toThrow("Full Europe");
});
test("checkpoint resumes complete artifacts only, refuses changed recipes and damaged files", async () => {
  const dir = await mkdtemp("/tmp/atlas-checkpoints-");
  try {
    const first = await new BuildCheckpoints(dir, "recipe-a").open();
    await Bun.write(dir + "/partial", "incomplete");
    expect(await first.reusable("partial")).toBe(false);
    await Bun.write(dir + "/area.osm.pbf", "verified bytes");
    await first.complete("area.osm.pbf");
    const resumed = await new BuildCheckpoints(dir, "recipe-a").open();
    expect(await resumed.reusable("area.osm.pbf")).toBe(true);
    expect(await Bun.file(dir + "/partial").exists()).toBe(false);
    await expect(new BuildCheckpoints(dir, "recipe-b").open()).rejects.toThrow(
      "changed",
    );
    await Bun.write(dir + "/area.osm.pbf", "corrupt! bytes");
    await expect(resumed.reusable("area.osm.pbf")).rejects.toThrow(
      "changed on disk",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cached build inputs must be published verified jobs; arbitrary paths and partial sources are refused", async () => {
  const dir = await mkdtemp("/tmp/atlas-cached-input-"),
    id = "a".repeat(32),
    sha256 = "b".repeat(64);
  const source = {
    id,
    state: "ready",
    kind: "planet",
    name: "test",
    bytes: 4,
    url: "https://planet.openstreetmap.org/pbf/planet-261005.osm.pbf",
    md5: "c".repeat(32),
    sha256,
    verifiedAt: new Date().toISOString(),
  };
  try {
    await Bun.write(`${dir}/${id}.json`, JSON.stringify(source));
    await Bun.write(`${dir}/${id}.osm.pbf`, "test");
    expect(await verifiedSources(dir)).toEqual([]);
    await Bun.write(`${dir}/${id}.osm.pbf.source.json`, JSON.stringify(source));
    const input = await verifiedSource(dir, id);
    expect(input.sha256).toBe(sha256);
    expect(input.mtimeMs).toBe((await stat(input.path)).mtimeMs);
    expect((await verifiedSources(dir))[0]).not.toHaveProperty("path");
    await expect(verifiedSource(dir, "../source")).rejects.toThrow("ID");
    await Bun.write(
      `${dir}/${id}.json`,
      JSON.stringify({ ...source, state: "verifying" }),
    );
    expect(await verifiedSources(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provenance uses the pinned source date rather than its publication date", () => {
  expect(
    cachedSourceDate({
      url: "https://planet.openstreetmap.org/pbf/planet-261005.osm.pbf",
      lastModified: "2026-10-08T12:00:00Z",
    }),
  ).toBe("2026-10-05");
});
