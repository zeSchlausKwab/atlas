import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { relative } from "node:path";
import {
  generalizeDisplaySource,
  inflateDisplaySource,
} from "../packages/cli/src/display-source";

const ring = (west: number, south: number, east: number, north: number) => {
  const corners = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return corners
    .slice(0, 4)
    .flatMap((a, i) =>
      Array.from({ length: 1000 }, (_, n) => [
        a[0]! + ((corners[i + 1]![0]! - a[0]!) * n) / 1000,
        a[1]! + ((corners[i + 1]![1]! - a[1]!) * n) / 1000,
      ]),
    )
    .concat([corners[0]!]);
};
const fixture = {
  type: "Feature",
  id: "relation/1",
  properties: {
    id: "relation/1",
    class: 1,
    name: "Water with an island",
    tags: { natural: "water", name: "Test" },
  },
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [ring(30, 20, 31, 21), ring(30.2, 20.2, 30.4, 20.4)],
      [ring(32, 20, 32.1, 20.1)],
    ],
  },
};

test("display decompression retains bytes and identifies malformed input", () => {
  const bytes = new TextEncoder().encode(JSON.stringify(fixture));
  expect(
    new Uint8Array(inflateDisplaySource(Bun.gzipSync(bytes), "relation/1")),
  ).toEqual(bytes);
  expect(() =>
    inflateDisplaySource(new Uint8Array([1, 2]), "relation/broken"),
  ).toThrow("relation/broken");
});

test("oversized display preprocessing honors cancellation before scratch or subprocesses", async () => {
  const abort = new AbortController();
  abort.abort(new Error("cancelled display"));
  await expect(
    generalizeDisplaySource(
      new Uint8Array(),
      "relation/1",
      6,
      "/unused",
      abort.signal,
      () => {},
    ),
  ).rejects.toThrow("cancelled display");
});

(Bun.which("ogr2ogr") ? test : test.skip)(
  "GDAL display generalization retains polygon parts, holes and exact tags, with scratch cleanup",
  async () => {
    const dir = await mkdtemp("/tmp/atlas-display-source-");
    const bytes = new TextEncoder().encode(JSON.stringify(fixture));
    const before = new Uint8Array(bytes);
    try {
      const f = await generalizeDisplaySource(
        bytes,
        "relation/1",
        6,
        relative(process.cwd(), dir),
        new AbortController().signal,
        () => {},
      );
      expect(f.id).toBe(fixture.id);
      expect(f.properties).toEqual(fixture.properties);
      expect(f.geometry.type).toBe("MultiPolygon");
      if (f.geometry.type !== "MultiPolygon")
        throw Error("Wrong geometry type");
      expect(f.geometry.coordinates.map((p) => p.length)).toEqual([2, 1]);
      for (const p of f.geometry.coordinates)
        for (const r of p) {
          expect(r.length).toBeLessThan(20);
          expect(r[0]!).toEqual(r.at(-1)!);
        }
      expect(f.geometry.coordinates[0]![0]).toContainEqual([30, 20]);
      expect(f.geometry.coordinates[0]![1]).toContainEqual([30.2, 20.2]);
      expect(bytes).toEqual(before);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
