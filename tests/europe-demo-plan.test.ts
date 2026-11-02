import { expect, test } from "bun:test";
import { europeDemoPlan } from "../scripts/europe-demo-plan";
import { OSM_ROUTING_CONTRACT } from "../packages/format/src/routing-contract";
const config = {
  cachedSources: [{ id: "planet", kind: "planet", sha256: "a".repeat(64) }],
  oceanSource: { sha256: "b".repeat(64) },
  globalSource: { snapshot: "geofabrik" },
  routingCompiler: {
    authority: "osm-pbf-sha256",
    contract: OSM_ROUTING_CONTRACT,
    codec: "rcl3",
  },
};
test("all three Europe jobs compile independently from the same verified planet", () => {
  const plan = europeDemoPlan(config, 29);
  expect(plan.maps).toHaveLength(3);
  for (const { selection: s } of plan.maps) {
    expect(s.cachedSourceId).toBe("planet");
    expect(s).not.toHaveProperty("sourceAtlasId");
    expect(s.snapshot).not.toStartWith("pending:");
    expect(s.profiles).toEqual(["walking", "cycling", "driving"]);
    expect(s.featureKinds).toContain("boundaries");
    expect(s.featureKinds).toContain("objects");
    expect(s.search && s.reverse && s.pois).toBe(true);
    expect(s.maxZoom).toBe(16);
  }
  expect(plan.maps[0]!.selection.polygon[1]![0]).toBe(29);
  expect(plan.maps[1]!.selection.polygon[1]![0]).toBeGreaterThan(
    plan.maps[2]!.selection.polygon[0]![0],
  );
});
test("independent queue refuses legacy servers and missing pinned sources", () => {
  expect(() =>
    europeDemoPlan({ ...config, routingCompiler: undefined }),
  ).toThrow("Deploy");
  expect(() => europeDemoPlan({ ...config, cachedSources: [] })).toThrow(
    "verified",
  );
  expect(() => europeDemoPlan(config, 19)).toThrow("Eastern edge");
});

test("reduced demo runs the adjacent pair first with ocean and every analysis family", () => {
  const plan = europeDemoPlan(config, 27, "north-sea");
  expect(plan.maps.map((m) => m.key)).toEqual([
    "lower-rhine-west",
    "lower-rhine-east",
    "north-sea",
  ]);
  const [west, east, big] = plan.maps.map((m) => m.selection);
  for (const s of [west, east, big]) {
    expect(s.ocean?.sha256).toBe(config.oceanSource.sha256);
    expect(s.minZoom).toBe(0);
    expect(s.maxZoom).toBe(16);
    expect(s.profiles).toEqual(["walking", "cycling", "driving"]);
    expect(s.featureKinds).toContain("objects");
    expect(s.featureKinds).toContain("boundaries");
    expect(
      s.search && s.reverse && s.pois && s.streetNames && s.placeNames,
    ).toBe(true);
    expect(s.cachedSourceId).toBe("planet");
    expect(s.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(s).not.toHaveProperty("sourceAtlasId");
  }
  expect(west.polygon[1][0]).toBeGreaterThan(east.polygon[0][0]);
  for (const s of [west, east])
    for (const [x, y] of s.polygon) {
      expect(x).toBeGreaterThanOrEqual(big.polygon[0][0]);
      expect(x).toBeLessThanOrEqual(big.polygon[2][0]);
      expect(y).toBeGreaterThanOrEqual(big.polygon[0][1]);
      expect(y).toBeLessThanOrEqual(big.polygon[2][1]);
    }
});
