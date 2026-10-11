import { test, expect } from "bun:test";
import { compilerProgress } from "../packages/provisioning/src/compiler-progress";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { BlockSpool } from "../packages/cli/src/block-spool";
import { partitionTiles } from "../packages/cli/src/partitioned-tiles";
import type { PackageSelection } from "../packages/provisioning/src/selection";
import type { InputBlock } from "../packages/format/src/writer";

const selection: PackageSelection = {
  snapshot: "0".repeat(64),
  name: "resume fixture",
  polygon: [
    [9.5, 47.13],
    [9.52, 47.13],
    [9.52, 47.15],
    [9.5, 47.15],
  ],
  minZoom: 13,
  maxZoom: 13,
  layers: ["buildings"],
  placeNames: false,
  streetNames: false,
  pois: false,
  profiles: [],
  search: false,
  reverse: false,
  peaks: false,
  featureKinds: [],
  paddingCells: 0,
  maxBytes: 50 * 1024 ** 2,
};
for (const [workers, resumeWorkers] of [
  [1, 3],
  [3, 1],
])
  test(`interrupted display build (${workers} → ${resumeWorkers} workers) resumes durable batches without missing or duplicate geometry`, async () => {
    const dir = await mkdtemp("/tmp/atlas-tile-resume-");
    const source = new Database(":memory:");
    source.run(
      "CREATE TABLE features(cell INTEGER,data BLOB); CREATE INDEX cells ON features(cell)",
    );
    const put = source.query("INSERT INTO features VALUES(?,?)");
    source.transaction(() => {
      for (let id = 0; id < 5001; id++) {
        const x = 9.501 + (id % 100) * 0.0001,
          y = 47.131 + Math.floor(id / 100) * 0.0001;
        put.run(
          10 + (id % 2),
          Bun.gzipSync(
            new TextEncoder().encode(
              JSON.stringify({
                type: "Feature",
                properties: {
                  id: `way/${id}`,
                  class: 2,
                  tags: { building: "yes" },
                },
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [x, y],
                      [x + 0.00005, y],
                      [x + 0.00005, y + 0.00005],
                      [x, y],
                    ],
                  ],
                },
              }),
            ),
          ),
        );
      }
    })();
    const collect = async (spool: BlockSpool) => {
      const blocks: InputBlock[] = [];
      await spool.write(
        {
          add: async (b) => {
            blocks.push(b);
          },
        },
        new AbortController().signal,
        () => {},
      );
      return blocks;
    };
    let resumed = new BlockSpool(dir + "/resume.sqlite", "fixture");
    const reference = new BlockSpool(dir + "/reference.sqlite", "fixture");
    try {
      const stop = new AbortController();
      await expect(
        partitionTiles(
          source,
          resumed,
          selection,
          stop.signal,
          (line) => {
            if ((compilerProgress(line)?.completed ?? 0) > 0) stop.abort();
          },
          workers,
        ),
      ).rejects.toThrow();
      expect(resumed.cursor).toBeGreaterThan(0);
      const checkpoint = resumed.cursor;
      // Simulate a crash with an uncommitted fragment: reopening must roll it back.
      resumed.begin();
      resumed.json("query/uncommitted", ["never publish"]);
      resumed.close();
      resumed = new BlockSpool(dir + "/resume.sqlite", "fixture");
      expect(resumed.cursor).toBe(checkpoint);
      const resumedProgress: number[] = [];
      await partitionTiles(
        source,
        resumed,
        selection,
        new AbortController().signal,
        (line) => resumedProgress.push(compilerProgress(line)!.completed!),
        resumeWorkers,
      );
      expect(resumedProgress[0]).toBeGreaterThan(0);
      expect(resumedProgress.at(-1)).toBe(5001);
      await partitionTiles(
        source,
        reference,
        selection,
        new AbortController().signal,
        () => {},
      );
      const actual = await collect(resumed),
        expected = await collect(reference);
      expect(actual.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
    } finally {
      resumed.close();
      reference.close();
      source.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
