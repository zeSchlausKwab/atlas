import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import { MAX_SEARCH_PAGE } from "../packages/geocoding/src/paging";
import type { InputBlock } from "../packages/format/src/writer";

test("dense address cells compile without oversized blocks or dropping locations", async () => {
  const dir = await mkdtemp("/tmp/atlas-dense-locations-");
  const builder = new PagedSearchBuilder(dir + "/search.sqlite");
  const blocks: InputBlock[] = [];
  try {
    for (let i = 0; i < 600; i++)
      builder.addLocation({
        id: `node/${i + 1}`,
        name: `Testgasse ${i + 1}`,
        aliases: [],
        kind: "address",
        category: "address",
        coordinates: [16.38, 48.208],
        address: {
          houseNumber: String(i + 1),
          street: "Testgasse",
          source: "osm-explicit",
        },
        tags: { note: "€".repeat(3000) },
      });
    await builder.finish(
      {
        add: async (b) => {
          blocks.push(b);
        },
      },
      { search: true, reverse: false },
    );
    expect(blocks.every((b) => b.bytes.length <= MAX_SEARCH_PAGE)).toBe(true);
    const root = JSON.parse(
      new TextDecoder().decode(
        blocks.find((b) => b.key === "search/locations")!.bytes,
      ),
    );
    expect(root.records).toBe(600);
    expect(blocks.some((b) => b.key.startsWith("search/locations-data/"))).toBe(
      true,
    );
  } finally {
    await builder.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

import {
  writeSearchCell,
  SEARCH_CELL_PAGE_TARGET,
} from "../packages/geocoding/src/cell-build";
import { readSearchCell } from "../packages/geocoding/src/cell-pages";
import { ordinalKey } from "../packages/geocoding/src/paging";
import { locations, AtlasGeocoder } from "../packages/geocoding/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { preparePackage } from "../packages/provisioning/src/prepare";
import type { Manifest } from "../packages/format/src/index";
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const m: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Dense addresses",
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds: [16.37, 48.2, 16.39, 48.22],
  minZoom: 0,
  maxZoom: 16,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: [
    "location-search",
    "semantic-locations",
    "address-search",
    "reverse-street",
  ],
  limitations: [],
  semantics: {
    version: 1,
    addresses: "osm-explicit",
    poiTags: true,
    administrativeHierarchy: false,
  },
};

test("paged cells round-trip through archive, workspace, search, reverse lookup and excerpts", async () => {
  const dir = await mkdtemp("/tmp/atlas-cell-roundtrip-");
  const builder = new PagedSearchBuilder(dir + "/search.sqlite");
  const writer = await new StreamWriter(
    dir + "/map.atlas",
    32 * 1024 ** 2,
  ).open();
  let reader: AtlasReader | undefined, excerpt: AtlasReader | undefined;
  try {
    for (let i = 0; i < 600; i++) {
      builder.addLocation({
        id: `node/${i + 1}`,
        name: `Testgasse ${i + 1}`,
        aliases: [],
        kind: "address",
        category: "address",
        coordinates: [16.38, 48.208],
        address: {
          houseNumber: String(i + 1),
          street: "Testgasse",
          source: "osm-explicit",
        },
        tags: { note: "€".repeat(3000) },
      });
      // >4 MiB of individually valid, spatially overlapping street geometries.
      builder.addStreet({
        id: `way/${i + 1}`,
        name: `Testgasse ${i + 1}`,
        aliases: [],
        category: "residential",
        coordinates: Array.from({ length: 400 }, (_, j) => [
          16.378 + j * 0.00001,
          48.208 + i * 0.0000001,
        ]),
      });
    }
    await builder.finish(writer);
    await writer.finish(m);
    reader = await new AtlasReader(
      new FileSource(Bun.file(dir + "/map.atlas")),
    ).open();
    const workspace = new AtlasWorkspace([reader], "interactive");
    const p = await workspace.prepare({
      bounds: m.bounds,
      families: ["locations"],
    });
    expect(p.records).toBe(600);
    expect(workspace.query({ workspace: p.workspace }).count).toBe(600);
    const geocoder = new AtlasGeocoder(reader);
    expect(
      (await geocoder.search("Testgasse 600")).matches.some(
        (r) => r.address?.houseNumber === "600",
      ),
    ).toBe(true);
    expect((await geocoder.reverse([16.38, 48.208])).match?.id).toBe("way/1");
    await preparePackage(
      reader,
      {
        snapshot: reader.index.manifest.snapshot,
        name: "Excerpt",
        polygon: [
          [16.379, 48.207],
          [16.381, 48.207],
          [16.381, 48.209],
          [16.379, 48.209],
        ],
        minZoom: 0,
        maxZoom: 16,
        layers: [],
        featureKinds: [],
        profiles: [],
        placeNames: false,
        streetNames: false,
        pois: false,
        search: true,
        reverse: true,
        peaks: false,
        paddingCells: 1,
        maxBytes: 32 * 1024 ** 2,
      },
      dir + "/excerpt.atlas",
      new AbortController().signal,
      () => {},
    );
    excerpt = await new AtlasReader(
      new FileSource(Bun.file(dir + "/excerpt.atlas")),
    ).open();
    expect(
      (
        await new AtlasWorkspace([excerpt], "interactive").prepare({
          bounds: [16.379, 48.207, 16.381, 48.209],
          families: ["locations"],
        })
      ).records,
    ).toBe(600);
    expect(
      (await new AtlasGeocoder(excerpt).reverse([16.38, 48.208])).match?.id,
    ).toBe("way/1");
  } finally {
    reader?.dispose();
    excerpt?.dispose();
    await builder.dispose();
    await writer.abort();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("cell pages include JSON overhead, preserve small legacy cells, prune disjoint pages and cancel", async () => {
  const blocks = new Map<string, Uint8Array>();
  let ordinal = 0;
  const row = (id: number, x: number) => ({
    json: JSON.stringify({
      id: `node/${id}`,
      name: "Test",
      aliases: [],
      kind: "address",
      category: "address",
      coordinates: [x, 48],
      tags: { note: "€".repeat(3000) },
    }),
  });
  const rows = Array.from({ length: 60 }, (_, i) =>
    row(i + 1, i < 28 ? 16 : 17),
  );
  await writeSearchCell(
    "locations",
    "cell",
    rows,
    () => ordinalKey("location-pages", ordinal++),
    async (k, v) => {
      blocks.set(k, encode(v));
    },
  );
  expect(
    [...blocks.values()].every((b) => b.length <= SEARCH_CELL_PAGE_TARGET),
  ).toBe(true);
  const keys: string[] = [];
  const reader = {
    block: async (k: string) => {
      keys.push(k);
      return blocks.get(k)!;
    },
  };
  let count = 0;
  for await (const bytes of readSearchCell(
    reader,
    "cell",
    "locations",
    [15.9, 47.9, 16.1, 48.1],
  ))
    count += locations(bytes).filter(
      (r) => r.record.coordinates[0] === 16,
    ).length;
  expect(count).toBe(28);
  expect(keys.length).toBeLessThan(blocks.size);
  await writeSearchCell(
    "locations",
    "small",
    [row(1, 16)],
    () => {
      throw new Error("Small cell must stay inline");
    },
    async (k, v) => {
      blocks.set(k, encode(v));
    },
  );
  expect(JSON.parse(new TextDecoder().decode(blocks.get("small"))).schema).toBe(
    "locations-v1",
  );
  const abort = new AbortController();
  abort.abort();
  await expect(
    readSearchCell(reader, "cell", "locations", undefined, abort.signal).next(),
  ).rejects.toThrow();
  const page = JSON.parse(new TextDecoder().decode(blocks.get("cell")))
    .pages[0];
  blocks.set(
    "bad",
    encode({
      schema: "locations-cell-paged-v1",
      pages: [{ ...page, key: "search/records/16/0/0" }],
    }),
  );
  await expect(
    readSearchCell(reader, "bad", "locations").next(),
  ).rejects.toThrow("Invalid search cell page");
  blocks.set(
    "bad",
    encode({
      schema: "locations-cell-paged-v1",
      pages: [{ ...page, count: page.count + 1 }],
    }),
  );
  await expect(
    readSearchCell(reader, "bad", "locations").next(),
  ).rejects.toThrow("Invalid search cell page payload");
  await expect(
    writeSearchCell(
      "locations",
      "big",
      [
        {
          json: JSON.stringify({
            id: "node/999",
            coordinates: [16, 48],
            tags: { note: "x".repeat(MAX_SEARCH_PAGE) },
          }),
        },
      ],
      () => "",
      async () => {},
    ),
  ).rejects.toThrow("record node/999 exceeds 4 MiB");
});
