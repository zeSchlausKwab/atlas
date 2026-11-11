import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileHash } from "../packages/cli/src/source";
import {
  prepareWorldInput,
  usesWorldInput,
} from "../packages/provisioning/src/world-input";
import type { VerifiedBuildSource } from "../packages/provisioning/src/cached-build";
import type { PackageSelection } from "../packages/provisioning/src/selection";
const selection: PackageSelection = {
  snapshot: "test",
  name: "World",
  polygon: [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
  ],
  minZoom: 0,
  maxZoom: 6,
  layers: ["water"],
  featureKinds: ["boundaries"],
  profiles: [],
  placeNames: true,
  streetNames: false,
  pois: false,
  search: false,
  reverse: false,
  peaks: false,
  paddingCells: 0,
  maxBytes: Number.MAX_SAFE_INTEGER,
};
test("world-family pruning never applies to routing, analysis archives, detailed or regional builds", () => {
  expect(usesWorldInput(selection)).toBe(true);
  for (const extra of [
    { maxZoom: 7 },
    { search: true },
    { profiles: ["walking"] },
    { featureKinds: ["objects"] },
    { layers: ["roads"] },
    {
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    },
  ])
    expect(usesWorldInput({ ...selection, ...extra } as PackageSelection)).toBe(
      false,
    );
});
test.skipIf(!Bun.which("osmium"))(
  "shared planet filter preserves boundary members and water, drops unrelated geometry, reuses and verifies cache",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-world-input-"));
    try {
      const xml = join(dir, "source.osm"),
        pbf = join(dir, "source.osm.pbf");
      await Bun.write(
        xml,
        `<osm version="0.6">
      <node id="1" lat="1" lon="1"/><node id="2" lat="1" lon="2"/><node id="3" lat="2" lon="2"/>
      <node id="4" lat="2" lon="1"/><node id="5" lat="3" lon="3"><tag k="place" v="city"/><tag k="name" v="Town"/></node>
      <node id="6" lat="4" lon="4"/><node id="7" lat="5" lon="5"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/></way>
      <way id="11"><nd ref="6"/><nd ref="7"/><tag k="waterway" v="river"/></way>
      <way id="12"><nd ref="6"/><nd ref="7"/><tag k="highway" v="residential"/></way>
      <relation id="20"><member type="way" ref="10" role="outer"/><tag k="type" v="boundary"/><tag k="boundary" v="administrative"/><tag k="admin_level" v="8"/></relation>
      </osm>`,
      );
      expect(await Bun.spawn(["osmium", "cat", xml, "-o", pbf]).exited).toBe(0);
      const source = {
        path: pbf,
        sha256: await fileHash(pbf),
      } as VerifiedBuildSource;
      const path = await prepareWorldInput(
        source,
        join(dir, "cache"),
        new AbortController().signal,
        () => {},
      );
      const proc = Bun.spawn(["osmium", "cat", path, "-f", "opl"], {
        stdout: "pipe",
      });
      const data = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(data).toContain("r20");
      expect(data).toContain("w10");
      expect(data).toContain("n1");
      expect(data).toContain("admin_level=8");
      expect(data).toContain("w11");
      expect(data).toContain("n5");
      expect(data).not.toContain("w12");
      const before = (await stat(path)).mtimeMs;
      expect(
        await prepareWorldInput(
          source,
          join(dir, "cache"),
          new AbortController().signal,
          () => {},
        ),
      ).toBe(path);
      expect((await stat(path)).mtimeMs).toBe(before);
      await Bun.write(path, "corrupt");
      await expect(
        prepareWorldInput(
          source,
          join(dir, "cache"),
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("changed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
