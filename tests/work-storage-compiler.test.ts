import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import type { PackageSelection } from "../packages/provisioning/src/selection";
const native =
  (await Bun.file("target/release/source-store").exists()) &&
  (await Bun.file("target/release/transport-partitioned").exists());
(native ? test : test.skip)(
  "split compiler keeps databases local, resumes NAS archives and preserves all package blocks",
  async () => {
    const dir = await mkdtemp("/tmp/atlas-compiler-storage-");
    const selection: PackageSelection = {
      snapshot: "0".repeat(64),
      name: "split storage fixture",
      polygon: [
        [15.99, 47.99],
        [16.01, 47.99],
        [16.01, 48.01],
        [15.99, 48.01],
      ],
      minZoom: 13,
      maxZoom: 14,
      layers: ["roads"],
      profiles: ["walking", "cycling", "driving"],
      placeNames: true,
      streetNames: true,
      pois: true,
      search: true,
      reverse: true,
      peaks: true,
      featureKinds: ["roads"],
      paddingCells: 0,
      maxBytes: 50 * 1024 ** 2,
    };
    const base = {
      input: "tests/fixtures/transport.osm.pbf",
      selection,
      reserveBytes: 0,
      workers: 1,
    };
    const messages: string[] = [];
    const split = {
      ...base,
      work: dir + "/ssd",
      artifacts: dir + "/nas",
      output: dir + "/nas/map.atlas",
      progress: (s: string) => messages.push(s),
    };
    const blocks = async (path: string) => {
      const r = await new AtlasReader(new FileSource(Bun.file(path))).open();
      try {
        const out: Record<string, string> = {};
        for await (const b of r.iterateBlocks())
          out[b.key] = new Bun.CryptoHasher("sha256")
            .update(await r.block(b.key))
            .digest("hex");
        return out;
      } finally {
        r.dispose();
      }
    };
    try {
      await compilePartitioned(split);
      const files = await readdir(dir + "/nas");
      expect(files.sort()).toEqual([
        "display.atlas",
        "map.atlas",
        "semantics.atlas",
        "transport.atlas",
      ]);
      expect(await Bun.file(dir + "/ssd/partitioned.json").exists()).toBe(true);
      const before = (await stat(dir + "/nas/transport.atlas")).mtimeMs;
      const result = await blocks(split.output);
      expect(Object.keys(result).some((k) => k.startsWith("routing/"))).toBe(
        true,
      );
      expect(Object.keys(result).some((k) => k.startsWith("tile/"))).toBe(true);
      expect(Object.keys(result).some((k) => k.startsWith("search/"))).toBe(
        true,
      );
      await compilePartitioned(split);
      expect((await stat(dir + "/nas/transport.atlas")).mtimeMs).toBe(before);
      expect(await blocks(split.output)).toEqual(result);
      await compilePartitioned({
        ...base,
        work: dir + "/single",
        output: dir + "/single/map.atlas",
        progress: () => {},
      });
      expect(await blocks(dir + "/single/map.atlas")).toEqual(result);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
