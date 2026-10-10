import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import {
  AtlasGeocoder,
  type Location,
  type Street,
} from "../packages/geocoding/src/index";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import type { Manifest } from "../packages/format/src/index";
const m: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "paged search",
  source: { url: "test", sha256: "0".repeat(64), attribution: "test" },
  bounds: [-180, -85, 180, 85],
  minZoom: 0,
  maxZoom: 16,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: ["location-search", "reverse-street"],
  limitations: [],
};
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
test("paged search preserves ranking, aliases, substrings, context and nearest streets with selective reads", async () => {
  const dir = await mkdtemp("/tmp/atlas-search-");
  const builder = new PagedSearchBuilder(dir + "/search.sqlite");
  const writer = await new StreamWriter(
    dir + "/map.atlas",
    20 * 1024 ** 2,
  ).open();
  try {
    const records: Location[] = Array.from({ length: 1200 }, (_, i) => ({
      id: `node/${i + 1}`,
      name: `Museum ${i}`,
      aliases: [],
      kind: "poi",
      category: "museum",
      coordinates: [i % 2 ? 16 : 8, 48],
    }));
    records.push(
      {
        id: "node/5000",
        name: "Äußere Straße",
        aliases: ["Outer Road"],
        kind: "street",
        category: "street",
        coordinates: [16.02, 48],
        context: "near Wien",
      },
      {
        id: "node/5001",
        name: "Wien",
        aliases: ["Vienna"],
        kind: "place",
        category: "city",
        coordinates: [16.03, 48],
      },
    );
    const streets: Street[] = [
      {
        id: "way/1",
        name: null,
        aliases: [],
        category: "service",
        coordinates: [
          [16, 48],
          [16.01, 48],
        ],
      },
      {
        id: "way/2",
        name: "Far road",
        aliases: [],
        category: "residential",
        coordinates: [
          [8, 48],
          [8.01, 48],
        ],
      },
    ];
    for (const r of [...records].reverse()) builder.addLocation(r);
    for (const s of streets) builder.addStreet(s);
    await builder.finish(writer);
    await writer.finish(m);
    const reads: string[] = [];
    const reader = await new AtlasReader(
      new FileSource(Bun.file(dir + "/map.atlas")),
      (e) => {
        reads.push(e.key);
      },
    ).open();
    const paged = new AtlasGeocoder(reader);
    const ref = await new AtlasReader(
      new FileSource(
        new Blob([
          await encodePackage(m, [
            {
              key: "search/locations",
              bytes: encode({ schema: "locations-v1", records }),
            },
            {
              key: "search/streets",
              bytes: encode({ schema: "streets-v1", streets }),
            },
          ]),
        ]),
      ),
    ).open();
    const legacy = new AtlasGeocoder(ref);
    for (const q of [
      "aussere",
      "ssere",
      "strasse wien",
      "outer road",
      "wien",
      "vienna",
      "museum 12",
      "m 123",
      "xxxxx",
    ]) {
      const a = await paged.search(q),
        b = await legacy.search(q);
      expect(a.matches).toEqual(b.matches);
      expect(a.total).toBe(b.total);
    }
    expect(reads.some((k) => k.startsWith("search/streets"))).toBe(false);
    expect(reads.some((k) => k.startsWith("search/locations-data"))).toBe(
      false,
    );
    reads.length = 0;
    expect((await paged.reverse([16.005, 48.0001])).match).toEqual(
      (await legacy.reverse([16.005, 48.0001])).match,
    );
    expect(
      reads.filter((k) => k.startsWith("search/streets-data")).length,
    ).toBeLessThan(3);
    reader.offline = true;
    expect((await paged.search("strasse wien")).matches[0]?.name).toBe(
      "Äußere Straße",
    );
    reader.cache.clear();
    await expect(paged.search("strasse wien")).rejects.toThrow("Not cached");
    reader.offline = false;
    expect((await paged.search("strasse wien")).matches).toEqual(
      (await legacy.search("strasse wien")).matches,
    );
    reader.dispose();
    ref.dispose();
  } finally {
    await builder.dispose();
    await writer.abort();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("broad name/context postings intersect without loading all candidates", async () => {
  const { termKey, termBucket, ordinalKey, POSTINGS_PER_PAGE } = await import(
    "../packages/geocoding/src/paging"
  );
  const blocks: { key: string; bytes: Uint8Array }[] = [],
    groups = new Map<number, any[]>();
  let page = 0;
  for (const [terms, start] of [
    [["alp", "lph", "pha"], 0],
    [["ome", "meg", "ega"], 49999],
  ] as [string[], number][]) {
    const begin = page,
      count = 50001;
    for (let i = 0; i < count; i += POSTINGS_PER_PAGE)
      blocks.push({
        key: ordinalKey("postings", page++),
        bytes: encode({
          schema: "postings-v1",
          ids: Array.from(
            { length: Math.min(POSTINGS_PER_PAGE, count - i) },
            (_, j) => start + i + j,
          ),
        }),
      });
    for (const term of terms) {
      const bucket = termBucket(term),
        values = groups.get(bucket) ?? [];
      values.push({ term, count, start: begin, pages: page - begin });
      groups.set(bucket, values);
    }
  }
  for (const [bucket, terms] of groups)
    blocks.push({
      key: termKey(bucket),
      bytes: encode({ schema: "terms-v1", terms }),
    });
  const recordPage = Math.floor(49999 / 256),
    records: Location[] = Array.from({ length: 256 }, (_, i) => ({
      id: `node/${recordPage * 256 + i}`,
      name: [49999, 50000].includes(recordPage * 256 + i)
        ? "Alpha Omega"
        : "Other",
      aliases: [],
      kind: "poi",
      category: "museum",
      coordinates: [16, 48],
    }));
  blocks.push(
    {
      key: ordinalKey("records", recordPage),
      bytes: encode({ schema: "locations-v1", records }),
    },
    {
      key: "search/locations",
      bytes: encode({
        schema: "locations-paged-v1",
        records: 100001,
        pages: Math.ceil(100001 / 256),
      }),
    },
  );
  const reader = await new AtlasReader(
    new FileSource(
      new Blob([
        await encodePackage(
          { ...m, capabilities: ["location-search"] },
          blocks,
          { paged: true },
        ),
      ]),
    ),
  ).open();
  const geocoder = new AtlasGeocoder(reader);
  expect((await geocoder.search("alpha omega")).total).toBe(2);
  await expect(geocoder.search("alpha")).rejects.toThrow("too broad");
  reader.dispose();
});
