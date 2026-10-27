import { test, expect } from "bun:test";
import { encodePackage } from "../packages/format/src/writer";
import { project, type Manifest } from "../packages/format/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { ChatDataRuntime } from "../packages/chat/src/data";
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const bounds: [number, number, number, number] = [14, 47, 20, 50];
async function fixture(overview: boolean | "inline" = true) {
  const m: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name: "regional locations",
    source: {
      url: "fixture",
      sha256: "a".repeat(64),
      attribution: "test",
      extraction: {
        bounds,
        strategy: "smart; types=multipolygon,restriction; partitioned-build-v1",
        sourceDate: "2026-10-05",
      },
    },
    bounds,
    minZoom: 0,
    maxZoom: 16,
    features: 0,
    places: [],
    peaks: 0,
    labelZoom: 12,
    capabilities: ["location-search", "map-labels"],
    limitations: [],
  };
  if (overview === "inline")
    m.selection = {
      polygon: [
        [14, 47],
        [20, 47],
        [20, 50],
        [14, 50],
      ],
      parentSnapshot: "b".repeat(64),
      boundaryPolicy: "clipped-labels-and-search",
      routingPaddingCells: 0,
    };
  const city = {
    id: "node/1",
    name: "City",
    kind: "place",
    category: "city",
    coordinates: [16, 48],
    aliases: [],
    tags: { place: "city", population: "12345" },
  };
  const cell = (p: number[]) => {
    const [x, y] = project(p[0]!, p[1]!);
    return `search/locations-data/14/${Math.floor(x * 16384)}/${Math.floor(y * 16384)}`;
  };
  const cells = new Map<string, unknown[]>();
  for (let i = 0; i < 160; i++) {
    const r = {
      id: `node/${i + 10}`,
      name: "Address",
      kind: "address",
      category: "address",
      coordinates: [14.5 + (i % 20) * 0.2, 47.1 + Math.floor(i / 20) * 0.2],
      aliases: [],
      tags: {},
    };
    const key = cell(r.coordinates);
    cells.set(key, [...(cells.get(key) ?? []), r]);
  }
  cells.set(cell(city.coordinates), [city]);
  const records = [...cells.values()].flat();
  const blocks = [
    {
      key: "search/locations",
      bytes: encode({
        schema: "locations-paged-v1",
        records: records.length,
        pages: 1,
      }),
    },
    ...Array.from(cells, ([key, records]) => ({
      key,
      bytes: encode({ schema: "locations-v1", records }),
      features: records.length,
    })),
    ...(overview
      ? [
          {
            key: "labels/places",
            bytes: encode(
              overview === "inline"
                ? {
                    schema: "places-v1",
                    places: [
                      { name: city.name, coordinates: city.coordinates },
                    ],
                  }
                : {
                    schema: "places-paged-v1",
                    zoom: 8,
                    overview: [
                      { name: city.name, coordinates: city.coordinates },
                    ],
                  },
            ),
          },
        ]
      : []),
  ];
  const bytes = await encodePackage(m, blocks, { paged: true }),
    source = new FileSource(new Blob([bytes])),
    reads: string[] = [];
  const reader = await new AtlasReader(source, undefined, {
    onTransfer: (e) => reads.push(e.key),
  }).open();
  return { reader, reads };
}
test("regional city selection reads candidate cells, retains population and exposes selection on results", async () => {
  const { reader, reads } = await fixture();
  const runtime = new ChatDataRuntime([reader]),
    progress: string[] = [];
  try {
    const p = await runtime.invoke(
      "workspace_prepare",
      {
        bounds,
        families: ["locations"],
        where: [
          { field: "kind", op: "eq", value: "place" },
          { field: "category", op: "eq", value: "city" },
        ],
      },
      new AbortController().signal,
      (m) => progress.push(m),
    );
    expect(p.records).toBe(1);
    expect(
      reads.filter((k) => k.startsWith("search/locations-data/")),
    ).toHaveLength(1);
    const q = await runtime.invoke(
      "workspace_query",
      { workspace: p.workspace },
      new AbortController().signal,
    );
    const rows = runtime.workspace.result(q.result, 0, 10, [
      "id",
      "tags.population",
    ]);
    expect(rows.rows[0]!["tags.population"]).toBe("12345");
    expect(rows.coverage.selection).toEqual([
      { field: "kind", op: "eq", value: "place" },
      { field: "category", op: "eq", value: "city" },
    ]);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toContain("ready");
    expect(runtime.workspace.catalog()[0]!.workspace.maxSpanDegrees).toBeNull();
  } finally {
    runtime.clear();
    reader.dispose();
  }
});
test("without a trusted settlement index preparation scans and filters, never claims an empty complete city result", async () => {
  const { reader, reads } = await fixture(false);
  const runtime = new ChatDataRuntime([reader]);
  try {
    const p = await runtime.invoke(
      "workspace_prepare",
      {
        bounds,
        families: ["locations"],
        where: [{ field: "category", op: "eq", value: "city" }],
      },
      new AbortController().signal,
    );
    expect(p.records).toBe(1);
    expect(
      reads.filter((k) => k.startsWith("search/locations-data/")).length,
    ).toBeGreaterThan(150);
  } finally {
    runtime.clear();
    reader.dispose();
  }
});
test("unfiltered broad preparation reports before reading and uses bounded concurrency", async () => {
  const { reader } = await fixture(false);
  let active = 0,
    peak = 0;
  const cells = await reader.spatial(
    "search/locations-data",
    14,
    0,
    16383,
    0,
    16383,
  );
  const payloadOffsets = new Set(
    cells.map((b) => reader.index.header.payloadOffset + b.offset),
  );
  const source = reader.source;
  const delayed = reader.fork(
    {},
    {
      read: async (a, b, s) => {
        const payload = payloadOffsets.has(a);
        if (payload) active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((r) => setTimeout(r, 2));
          return await source.read(a, b, s);
        } finally {
          if (payload) active--;
        }
      },
    },
  );
  const runtime = new ChatDataRuntime([delayed]);
  const messages: string[] = [];
  try {
    const p = await runtime.invoke(
      "workspace_prepare",
      { bounds, families: ["locations"] },
      new AbortController().signal,
      (m) => messages.push(m),
    );
    expect(p.records).toBe(161);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(messages.some((m) => m.includes("cells"))).toBe(true);
  } finally {
    runtime.clear();
    delayed.dispose();
    reader.dispose();
  }
});

test("inline settlement anchors from prepared excerpts retain the city selection fast path", async () => {
  const { reader, reads } = await fixture("inline");
  const runtime = new ChatDataRuntime([reader]);
  try {
    const p = await runtime.invoke(
      "workspace_prepare",
      {
        bounds,
        families: ["locations"],
        where: [
          { field: "kind", op: "eq", value: "place" },
          { field: "category", op: "eq", value: "city" },
        ],
      },
      new AbortController().signal,
    );
    expect(p.records).toBe(1);
    expect(
      reads.filter((k) => k.startsWith("search/locations-data/")),
    ).toHaveLength(1);
  } finally {
    runtime.clear();
    reader.dispose();
  }
});
test("unknown producers cannot use a partial display overview as a complete city index", async () => {
  const { reader, reads } = await fixture();
  reader.index.manifest.source.extraction!.strategy = "other-compiler";
  const runtime = new ChatDataRuntime([reader]);
  try {
    const p = await runtime.invoke(
      "workspace_prepare",
      {
        bounds,
        families: ["locations"],
        where: [
          { field: "kind", op: "eq", value: "place" },
          { field: "category", op: "eq", value: "city" },
        ],
      },
      new AbortController().signal,
    );
    expect(p.records).toBe(1);
    expect(
      reads.filter((k) => k.startsWith("search/locations-data/")).length,
    ).toBeGreaterThan(150);
  } finally {
    runtime.clear();
    reader.dispose();
  }
});
test.each(["planning", "reading"] as const)(
  "cancelling parallel preparation during %s drains reads and allows a fresh preparation",
  async (phase) => {
    const { reader } = await fixture(false);
    const cells =
      phase === "reading"
        ? await reader.spatial("search/locations-data", 14, 0, 16383, 0, 16383)
        : [];
    const payloadOffsets = new Set(
      cells.map((b) => reader.index.header.payloadOffset + b.offset),
    );
    const c = new AbortController();
    let pending = 0,
      requests = 0;
    const delayed = reader.fork(
      {},
      {
        read: async (a, b, s) => {
          pending++;
          try {
            if (
              (phase === "planning" || payloadOffsets.has(a)) &&
              ++requests === 10
            )
              c.abort(new DOMException("Cancelled test", "AbortError"));
            await new Promise((r) => setTimeout(r, 1));
            s?.throwIfAborted();
            return await reader.source.read(a, b, s);
          } finally {
            pending--;
          }
        },
      },
    );
    const runtime = new ChatDataRuntime([delayed]);
    try {
      await expect(
        runtime.invoke(
          "workspace_prepare",
          { bounds, families: ["locations"] },
          c.signal,
        ),
      ).rejects.toThrow("Cancelled test");
      expect(pending).toBe(0);
      const p = await runtime.invoke(
        "workspace_prepare",
        { bounds, families: ["locations"] },
        new AbortController().signal,
      );
      expect(p.records).toBe(161);
    } finally {
      runtime.clear();
      delayed.dispose();
      reader.dispose();
    }
  },
);
