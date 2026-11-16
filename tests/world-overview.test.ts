import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  compileWorldOverview,
  worldOverviewSelection,
  type WorldData,
} from "../packages/provisioning/src/world-overview";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import {
  readBoundaries,
  containingBoundaries,
} from "../packages/boundaries/src/index";
import { AtlasFeatures } from "../packages/features/src/index";
import { decodePlaces } from "../packages/labels/src/places";
import { tileRecords } from "../packages/format/src/tiles";
const fc = (features: any[]) => ({
  type: "FeatureCollection" as const,
  features,
});
const box = (
  w: number,
  s: number,
  e: number,
  n: number,
  properties: any = {},
) => ({
  type: "Feature" as const,
  properties,
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  },
});
const data: WorldData = {
  countries: fc([
    box(0, 0, 10, 10, { NE_ID: 42, NAME_EN: "Example", ISO_A3: "EXM" }),
    box(0, -90, 20, -80, { NE_ID: 43, NAME_EN: "South" }),
  ]),
  ocean: fc([box(-180, -90, 0, 90)]),
  lakes: fc([box(2, 2, 3, 3)]),
  places: fc([
    {
      type: "Feature",
      properties: { NAME: "Capital" },
      geometry: { type: "Point", coordinates: [5, 5] },
    },
  ]),
};
test("world overview retains external country identities, clips poles, and supports ordinary Atlas reads", async () => {
  const dir = await mkdtemp("/tmp/atlas-world-test-");
  try {
    const progress: any[] = [];
    await compileWorldOverview(
      data,
      dir + "/world.atlas",
      "World fixture",
      new AbortController().signal,
      (p) => progress.push(p),
    );
    const r = await new AtlasReader(
      new FileSource(Bun.file(dir + "/world.atlas")),
    ).open();
    try {
      const features = [];
      for await (const f of readBoundaries(r, [-180, -85, 180, 85]))
        features.push(f);
      expect(features.map((f) => f.id)).toEqual([
        "natural-earth/admin-0/42",
        "natural-earth/admin-0/43",
      ]);
      expect(features[1]!.bbox![1]).toBe(-85);
      expect((await containingBoundaries(r, [5, 5])).features[0]!.id).toBe(
        "natural-earth/admin-0/42",
      );
      const extracted = [];
      for await (const f of new AtlasFeatures(r).scan({
        kind: "boundaries",
        bounds: [0, 0, 10, 10],
      }))
        extracted.push(f);
      expect(extracted).toHaveLength(1);
      expect(decodePlaces(await r.block("labels/places"))[0]!.name).toBe(
        "Capital",
      );
      for (const layer of ["land", "water"]) {
        const records = [...tileRecords(await r.block(`tile/${layer}/0/0/0`))];
        expect(records.length).toBeGreaterThan(0);
        expect(records[0]!.class).toBe(layer === "water" ? 1 : 0);
      }
      expect(r.index.manifest.capabilities).not.toContain("transport-routing");
      expect(r.index.manifest.source.attribution).toContain("Natural Earth");
      expect(progress.at(-1).completed).toBe(progress.at(-1).total);
    } finally {
      r.dispose();
    }
    const stop = new AbortController();
    stop.abort();
    await expect(
      compileWorldOverview(
        data,
        dir + "/cancel.atlas",
        "Cancelled",
        stop.signal,
      ),
    ).rejects.toThrow();
    expect(await Bun.file(dir + "/cancel.atlas").exists()).toBe(false);
    expect(() => worldOverviewSelection(" ")).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
