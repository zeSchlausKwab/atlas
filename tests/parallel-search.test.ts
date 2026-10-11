import { test, expect } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import type { InputBlock } from "../packages/format/src/writer";
import { compilerProgress } from "../packages/provisioning/src/compiler-progress";
import { AtlasGeocoder } from "../packages/geocoding/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";

test("parallel index is byte-identical to serial search across shard boundaries, aliases and long postings", async () => {
  const dir = await mkdtemp("/tmp/atlas-search-parallel-");
  const build = async (workers: number, records = 4609) => {
    const builder = new PagedSearchBuilder(
        `${dir}/${workers}-${records}.sqlite`,
      ),
      blocks: InputBlock[] = [];
    const stages = new Map<string, number>();
    try {
      for (let i = records - 1; i >= 0; i--)
        builder.addLocation({
          id: `node/${i}`,
          name: `Museum Äußere Straße ${i}`,
          aliases: ["Outer Road", `Gallery ${i}`],
          context: "Near Wien",
          kind: "poi",
          category: "museum",
          coordinates: [16 + (i % 200) / 1000, 48],
        });
      if (records)
        builder.addLocation({
          id: "node/0",
          name: "Replacement",
          aliases: ["Museum"],
          kind: "place",
          category: "city",
          coordinates: [16, 48],
        });
      await builder.finish(
        {
          add: async (b) => {
            blocks.push(b);
          },
        },
        { search: true, reverse: true, workers },
        undefined,
        (line) => {
          const p = compilerProgress(line)!;
          expect(p).toBeDefined();
          expect(p.completed!).toBeLessThanOrEqual(p.total!);
          stages.set(p.stage!, p.completed!);
        },
      );
      if (workers > 1 && records) {
        expect(stages.get("search-records")).toBe(records);
        expect(stages.get("search-record-pages")).toBe(records);
      }
      return blocks;
    } finally {
      await builder.dispose();
    }
  };
  try {
    const serial = await build(1);
    for (const workers of [3, 6]) expect(await build(workers)).toEqual(serial);
    expect(await build(3, 0)).toEqual(await build(1, 0));
    const data = await encodePackage(
      {
        format: "atlas",
        version: 1,
        name: "parity",
        source: {
          url: "fixture",
          sha256: "0".repeat(64),
          attribution: "fixture",
        },
        bounds: [15, 47, 17, 49],
        minZoom: 0,
        maxZoom: 16,
        features: 0,
        peaks: 0,
        places: [],
        capabilities: ["location-search"],
        limitations: [],
      },
      serial,
      { paged: true },
    );
    const reader = await new AtlasReader(
      new FileSource(new Blob([data])),
    ).open();
    try {
      expect(
        (await new AtlasGeocoder(reader).search("Äußere Straße 44")).matches
          .length,
      ).toBeGreaterThan(0);
    } finally {
      reader.dispose();
    }
    expect(
      (await readdir(dir)).filter((name) => name.includes("parallel")),
    ).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

test("cancelling parallel indexing removes worker scratch and does not publish index pages", async () => {
  const dir = await mkdtemp("/tmp/atlas-search-cancel-"),
    builder = new PagedSearchBuilder(`${dir}/input.sqlite`),
    abort = new AbortController();
  let writes = 0;
  try {
    for (let i = 0; i < 20000; i++)
      builder.addLocation({
        id: String(i).padStart(6, "0"),
        name: `Street ${i}`,
        aliases: [],
        kind: "street",
        category: "road",
        coordinates: [16, 48],
      });
    await expect(
      builder.finish(
        {
          add: async () => {
            writes++;
          },
        },
        { search: true, reverse: false, workers: 3 },
        abort.signal,
        (line) => {
          const p = compilerProgress(line);
          if (p?.stage === "search-records" && (p.completed ?? 0) > 0)
            abort.abort();
        },
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
    expect(
      (await readdir(dir)).filter((name) => name.includes("parallel")),
    ).toEqual([]);
  } finally {
    await builder.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
