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
