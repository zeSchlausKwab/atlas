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
      e => { reads.push(e.key); },
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
