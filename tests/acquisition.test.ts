import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Acquisitions } from "../apps/server/acquisitions";
import { AcquisitionCache } from "../apps/server/acquisition-cache";
import { publishedHost } from "./helpers/published-host";
import { pluginFixture, polygon } from "./helpers/plugin-fixture";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import { AtlasGeocoder } from "../packages/geocoding/src/index";
import { planAcquisition } from "../packages/acquisition/src/plan";
import { sha256, project, unproject } from "../packages/format/src/index";
import { encodePlaces } from "../packages/labels/src/places";
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
async function settled(manager: Acquisitions) {
  const end = Date.now() + 20000;
  while (
    manager
      .view()
      .some((j) => ["planning", "fetching", "packing"].includes(j.state))
  ) {
    if (Date.now() > end) throw Error(JSON.stringify(manager.view()));
    await Bun.sleep(5);
  }
  // State is set before the final durable save and active-task cleanup.
  await Bun.sleep(10);
}
const request = {
  name: "Offline trip",
  polygon,
  families: ["features:water", "addresses", "labels", "query"],
  minZoom: 0,
  maxZoom: 0,
  paddingCells: 0,
  sourceIds: ["publisher"],
};
test("selective acquisition resumes pinned cached data and exports search, labels, peaks and features without its publisher", async () => {
  const dir = await mkdtemp("/tmp/atlas-area-"),
    f = await pluginFixture();
  let host: Awaited<ReturnType<typeof publishedHost>> | undefined,
    manager: Acquisitions | undefined;
  try {
    const inputs: InputBlock[] = [];
    for await (const b of f.reader.iterateBlocks())
      inputs.push({
        key: b.key,
        bytes: await f.reader.block(b.key),
        features: b.features,
      });
    const builder = new PagedSearchBuilder(dir + "/search.sqlite");
    builder.addLocation({
      id: "node/400",
      name: "Testgasse 4",
      aliases: [],
      kind: "address",
      category: "address",
      coordinates: [9.02, 47.02],
      address: {
        source: "osm-explicit",
        houseNumber: "4",
        street: "Testgasse",
      },
    });
    builder.addLocation({
      id: "node/401",
      name: "Elsewhere 9",
      aliases: [],
      kind: "address",
      category: "address",
      coordinates: [9.8, 47.8],
      address: {
        source: "osm-explicit",
        houseNumber: "9",
        street: "Elsewhere",
      },
    });
    await builder.finish(
      {
        async add(b) {
          inputs.push(b);
        },
      },
      { search: true, reverse: false },
    );
    await builder.dispose();
    // Dense-cell catalog whose record leaf must be included without global postings.
    const inline = inputs.find((b) =>
      b.key.startsWith("search/locations-data/"),
    )!;
    const leaf = "search/location-pages/16/0/0";
    const records = JSON.parse(new TextDecoder().decode(inline.bytes)).records;
    inputs.push({ key: leaf, bytes: inline.bytes });
    inline.bytes = encode({
      schema: "locations-cell-paged-v1",
      pages: [
        {
          key: leaf,
          bounds: [9.01, 47.01, 9.03, 47.03],
          count: records.length,
        },
      ],
    });
    const [x, y] = project(9.02, 47.02).map((v) => Math.floor(v * 256));
    inputs.push(
      {
        key: "labels/places",
        bytes: encode({ schema: "places-paged-v1", zoom: 8, overview: [] }),
      },
      {
        key: `labels/settlements/8/${x}/${y}`,
        bytes: encodePlaces([
          {
            name: "Test town",
            coordinates: [9.02, 47.02],
            kind: "town",
          } as any,
        ]),
      },
      {
        key: "query/peaks",
        bytes: encode({
          schema: "peaks-paged-v1",
          known: 1,
          unknown: 0,
          peak: {
            name: "Test peak",
            elevation: 400,
            coordinates: [9.03, 47.03],
          },
        }),
      },
      {
        key: `query/peaks-data/8/${x}/${y}`,
        bytes: encode([
          { name: "Test peak", elevation: 400, coordinates: [9.03, 47.03] },
        ]),
      },
    );
    // Unrequested family must not survive in the output.
    inputs.push({
      key: "custom/unused",
      bytes: crypto.getRandomValues(new Uint8Array(60000)),
    });
    const m = f.reader.index.manifest;
    const bytes = await encodePackage(
      {
        ...m,
        bounds: [9, 47, 10, 48],
        featureKinds: ["water"],
        labelZoom: 12,
        semantics: {
          version: 1,
          addresses: "osm-explicit",
          poiTags: true,
          administrativeHierarchy: false,
        } as any,
        capabilities: [
          ...m.capabilities,
          "map-labels",
          "location-search",
          "address-search",
          "peak-query",
        ],
      },
      inputs,
      { paged: true },
    );
    await Bun.write(dir + "/source.atlas", bytes);
    host = await publishedHost(dir + "/source.atlas", dir + "/publisher");
    manager = await Acquisitions.open(dir + "/areas", async () => {});
    const id = await manager.create(request, [
      {
        id: "publisher",
        offer: host.offer,
        manifest: host.offer.manifest,
        location: "remote",
        verified: true,
        bytes: bytes.length,
        root: host.offer.hashtree!.root,
      },
    ]);
    await settled(manager);
    expect(manager.view()[0]!.state).toBe("review");
    expect(manager.view()[0]!.plan!.incomplete).toBe(false);
    const saved = await Bun.file(dir + `/areas/${id}/plan.json`).json();
    expect(
      (await Bun.file(dir + `/areas/${id}.json`).json()).plan,
    ).toBeUndefined();
    const keys = saved.parts.flatMap((p: any) =>
      p.blocks.map((b: any) => b.key),
    ) as string[];
    expect(keys.some((k) => k.startsWith("search/locations-data/"))).toBe(true);
    expect(keys.includes(leaf)).toBe(true);
    expect(keys.some((k) => k.startsWith("search/terms/"))).toBe(false);
    expect(keys.includes("custom/unused")).toBe(false);
    expect(keys.some((k) => k.startsWith("labels/settlements/"))).toBe(true);
    await manager.close();
    manager = await Acquisitions.open(dir + "/areas", async () => {});
    await manager.resume(id);
    await settled(manager);
    expect(manager.view()[0]!.error).toBeUndefined();
    expect(manager.view()[0]!.state).toBe("ready");
    host.unavailable();
    const reader = await new AtlasReader(
      new FileSource(manager.file(id)),
    ).open();
    const geo = new AtlasGeocoder(reader);
    const result = await geo.search("Testgasse 4");
    expect(JSON.stringify(result)).toContain("node/400");
    expect(JSON.stringify(await geo.search("Elsewhere 9"))).not.toContain(
      "node/401",
    );
    expect(await reader.highestPeak()).toMatchObject({
      peak: { name: "Test peak" },
    });
    const outputKeys = [];
    for await (const b of reader.iterateBlocks()) outputKeys.push(b.key);
    expect(outputKeys.includes("custom/unused")).toBe(false);
    expect(host.stats().rawRequests).toBe(0);
    reader.dispose();
  } finally {
    await manager?.close();
    await host?.close();
    f.reader.dispose();
    f.engine.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("acquisition reports gaps, rejects unknown adapters and prefers local duplicate providers", async () => {
  const f = await pluginFixture();
  try {
    const manifest = {
      ...f.reader.index.manifest,
      featureKinds: ["water" as const],
    };
    const sources = [
      {
        id: "remote",
        manifest,
        reader: f.reader,
        location: "remote" as const,
        verified: true,
        bytes: f.bytes.length,
      },
      {
        id: "local",
        manifest,
        reader: f.reader,
        location: "local" as const,
        verified: true,
        bytes: f.bytes.length,
      },
    ];
    const p = await planAcquisition(
      {
        ...request,
        families: ["features:water"],
        sourceIds: ["remote", "local"],
      },
      sources,
      new AbortController().signal,
    );
    expect(p.parts.map((p) => p.sourceId)).toEqual(["local"]);
    expect(p.remoteBytes).toBe(0);
    const gap = await planAcquisition(
      {
        ...request,
        families: ["features:water", "addresses"],
        sourceIds: ["local"],
      },
      sources,
      new AbortController().signal,
    );
    expect(gap.incomplete).toBe(true);
    expect(
      planAcquisition(
        { ...request, families: ["custom:magic"] },
        sources,
        new AbortController().signal,
      ),
    ).rejects.toThrow("supported capabilities");
  } finally {
    f.reader.dispose();
    f.engine.destroy();
  }
});
test("cache checks hashes, shares immutable content and recovers corruption", async () => {
  const dir = await mkdtemp("/tmp/atlas-area-cache-");
  try {
    const c = new AcquisitionCache(dir),
      bytes = encode("data"),
      hash = await sha256(bytes),
      b = {
        key: "tile/water/0/0/0",
        hash,
        length: bytes.length,
        offset: 0,
        features: 0,
      };
    await c.put("one", b, bytes);
    expect(await c.get("two", { ...b, key: "another/key" })).toEqual(bytes);
    await Bun.write(`${dir}/${hash.slice(0, 2)}/${hash}`, "broken");
    expect(await c.get("one", b)).toBeUndefined();
    await c.put("one", b, bytes);
    expect(await c.get("one", b)).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("large area export retains paged settlements beyond the viewport page limit", async () => {
  const { preparePackage } = await import(
    "../packages/provisioning/src/prepare"
  );
  const { familySelection } = await import(
    "../packages/provisioning/src/families"
  );
  const { decodePlaces } = await import("../packages/labels/src/places");
  const f = await pluginFixture(),
    dir = await mkdtemp("/tmp/atlas-places-area-");
  let reader: AtlasReader | undefined, out: AtlasReader | undefined;
  try {
    const nw = unproject(112 / 256, 75 / 256),
      se = unproject(129 / 256, 92 / 256);
    const inputs: InputBlock[] = [
      {
        key: "labels/places",
        bytes: encode({ schema: "places-paged-v1", zoom: 8, overview: [] }),
      },
    ];
    for (let x = 112; x < 129; x++)
      for (let y = 75; y < 92; y++)
        inputs.push({
          key: `labels/settlements/8/${x}/${y}`,
          bytes: encodePlaces([
            {
              name: `Town ${x}/${y}`,
              coordinates: unproject((x + 0.5) / 256, (y + 0.5) / 256),
              kind: "town",
            } as any,
          ]),
        });
    const bytes = await encodePackage(
      {
        ...f.reader.index.manifest,
        bounds: [nw[0], se[1], se[0], nw[1]],
        capabilities: ["map-labels"],
        labelZoom: 12,
      },
      inputs,
      { paged: true },
    );
    reader = await new AtlasReader(new FileSource(new Blob([bytes]))).open();
    const selection = familySelection(
      reader.index.manifest,
      ["labels"],
      "Wide area",
      1024 ** 2,
      0,
    );
    await preparePackage(
      reader,
      selection,
      dir + "/area.atlas",
      new AbortController().signal,
      () => {},
    );
    out = await new AtlasReader(
      new FileSource(Bun.file(dir + "/area.atlas")),
    ).open();
    expect(
      JSON.parse(new TextDecoder().decode(await out.block("labels/places")))
        .schema,
    ).toBe("places-paged-v1");
    let count = 0,
      pages = 0;
    for await (const b of out.iterateBlocks())
      if (b.key.startsWith("labels/settlements/")) {
        pages++;
        count += decodePlaces(await out.block(b.key)).length;
      }
    expect(pages).toBe(289);
    expect(count).toBe(289);
  } finally {
    reader?.dispose();
    out?.dispose();
    f.reader.dispose();
    f.engine.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
