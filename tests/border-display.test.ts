import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BorderDisplayWriter } from "../packages/boundaries/src/display-build";
import {
  BORDER_ROOT,
  simplifyBorder,
  validateBorderCatalog,
  validateBorderPage,
  visibleBorderPages,
} from "../packages/boundaries/src/display";
import { addBorderDisplay } from "../packages/boundaries/src/display-upgrade";
import { BoundaryWriter } from "../packages/boundaries/src/build";
import { boundaryCatalog } from "../packages/boundaries/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { project, type Manifest } from "../packages/format/src/index";
import { planComposition } from "../packages/renderer/src/composition-plan";
import {
  BorderOverlay,
  clipBorderLines,
} from "../packages/renderer/src/borders";
import { PAPER } from "../packages/renderer/src/style";
import type { MapFeature } from "../packages/features/src/index";

const area = (id: string, level: number, x = 0): MapFeature => ({
  type: "Feature",
  id,
  bbox: [x, 0, x + 1, 1],
  properties: {
    id,
    name: id,
    kind: "boundaries",
    tags: { boundary: "administrative", admin_level: String(level) },
  },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x, 0],
        [x + 1, 0],
        [x + 1, 1],
        [x, 1],
        [x, 0],
      ],
      [
        [x + 0.2, 0.2],
        [x + 0.4, 0.2],
        [x + 0.4, 0.4],
        [x + 0.2, 0.4],
        [x + 0.2, 0.2],
      ],
    ],
  },
});
const manifest: Omit<Manifest, "snapshot"> = {
  format: "atlas",
  version: 1,
  name: "Borders",
  bounds: [-180, -85, 180, 85],
  minZoom: 0,
  maxZoom: 6,
  source: { url: "fixture", sha256: "a".repeat(64), attribution: "Synthetic" },
  features: 0,
  peaks: 0,
  places: [],
  tileLayers: [],
  featureKinds: ["boundaries"],
  featureZoom: 12,
  capabilities: [
    "administrative-boundaries",
    "boundary-rendering",
    "feature-extraction",
  ],
  limitations: [],
};
async function fixture() {
  const blocks: InputBlock[] = [],
    writer = new BoundaryWriter({
      add: async (b) => {
        blocks.push(b);
      },
    });
  for (const f of [
    area("relation/1", 2),
    area("relation/2", 4),
    area("relation/3", 8),
    area("relation/4", 2, 90),
  ])
    await writer.add(f);
  await writer.finish();
  return {
    blocks,
    bytes: await encodePackage(manifest, blocks, { paged: true }),
  };
}
test("borders are selective map reads; national, regional and local areas have separate pages", async () => {
  const { bytes } = await fixture(),
    keys: string[] = [];
  const r = await new AtlasReader(
    new FileSource(new Blob([bytes])),
    (e) => keys.push(e.key),
    { purposes: ["map"] },
  ).open();
  const c = validateBorderCatalog(
    JSON.parse(new TextDecoder().decode(await r.block(BORDER_ROOT))),
  );
  const nw = project(-2, 2),
    se = project(2, -2),
    view: [number, number, number, number] = [nw[0], nw[1], se[0], se[1]];
  expect(visibleBorderPages(c, view, 0).map((p) => p.level)).toEqual([2]);
  expect(visibleBorderPages(c, view, 4).map((p) => p.level)).toEqual([2, 4]);
  expect(visibleBorderPages(c, view, 8).map((p) => p.level)).toEqual([2, 4, 8]);
  for (const page of visibleBorderPages(c, view, 0)) {
    const borders = validateBorderPage(
      JSON.parse(new TextDecoder().decode(await r.block(page.key))),
      page,
    );
    expect(borders[0]!.lines).toHaveLength(2); // holes remain outlines, not filled regions
  }
  expect(keys.some((k) => k.startsWith("boundaries/"))).toBe(false);
  await expect(boundaryCatalog(r)).rejects.toThrow();
  r.dispose();
});
test("display amendment preserves every previous payload hash and source authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-borders-"));
  const { blocks } = await fixture();
  const oldManifest = {
    ...manifest,
    capabilities: manifest.capabilities.filter(
      (c) => c !== "boundary-rendering",
    ),
  };
  const oldBytes = await encodePackage(
    oldManifest,
    blocks.filter((b) => !b.key.startsWith("boundary-display/")),
    { paged: true },
  );
  const input = join(dir, "old.atlas"),
    output = join(dir, "new.atlas");
  await Bun.write(input, oldBytes);
  try {
    await addBorderDisplay(input, output, new AbortController().signal);
    const old = await new AtlasReader(new FileSource(Bun.file(input))).open();
    const next = await new AtlasReader(new FileSource(Bun.file(output))).open();
    const hashes = new Map(
      (await next.allBlocks()).map((b) => [b.key, b.hash]),
    );
    for (const b of await old.allBlocks())
      expect(hashes.get(b.key)).toBe(b.hash);
    expect(next.index.manifest.source).toEqual(old.index.manifest.source);
    expect(next.index.manifest.amendment?.parentSnapshot).toBe(
      old.index.manifest.snapshot,
    );
    expect((await boundaryCatalog(next)).count).toBe(4);
    await expect(
      addBorderDisplay(
        output,
        join(dir, "duplicate.atlas"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("already");
    old.dispose();
    next.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("date-line jumps are split, and malformed/unbounded display pages are rejected", () => {
  const lines = simplifyBorder(
    [
      [179, 1],
      [180, 2],
      [-180, 2],
      [-179, 1],
    ],
    5,
  );
  expect(lines).toHaveLength(2);
  expect(
    lines.every((l) =>
      l.every((p, i) => !i || Math.abs(p[0] - l[i - 1]![0]) <= 180),
    ),
  ).toBe(true);
  expect(() =>
    validateBorderCatalog({
      schema: "boundary-display-v1",
      count: 1,
      pages: [
        {
          key: "boundaries/geometry/16/0/0",
          level: 2,
          bbox: [0, 0, 1, 1],
          count: 1,
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    validateBorderPage(
      {
        schema: "boundary-lines-v1",
        borders: [
          {
            ...area("relation/1", 2),
            level: 2,
            lines: [
              [
                [0, 0],
                [Infinity, 0],
              ],
            ],
          },
        ],
      },
      {
        key: "boundary-display/16/0/0",
        level: 2,
        bbox: [0, 0, 1, 1],
        count: 1,
      },
    ),
  ).toThrow();
});
test("border composition is opt-in, independent of land, and uses source priority", () => {
  const source = {
    id: "a",
    manifest: { ...manifest, snapshot: "b".repeat(64) },
    enabled: true,
    labels: false,
    layers: [],
  };
  expect(planComposition([source], 4)).toHaveLength(0);
  const plan = planComposition(
    [
      { ...source, boundaries: true },
      { ...source, id: "b", boundaries: true },
    ],
    4,
  );
  expect(plan.map((p) => [p.source, p.channel])).toEqual([["a", "boundaries"]]);
});
test("disabled or disposed overlays do not fetch; late reads cannot restart them", async () => {
  let calls = 0,
    changed = 0;
  let resolve!: (b: Uint8Array) => void;
  const r = {
    index: { manifest },
    block: () => {
      calls++;
      return new Promise<Uint8Array>((r) => (resolve = r));
    },
  } as unknown as AtlasReader;
  const overlay = new BorderOverlay(
    r,
    () => changed++,
    () => {
      throw new Error("Unexpected error");
    },
  );
  overlay.update([0, 0, 1, 1], 4, false);
  expect(calls).toBe(0);
  overlay.update([0, 0, 1, 1], 4, true);
  expect(calls).toBe(1);
  overlay.destroy();
  resolve(
    new TextEncoder().encode(
      JSON.stringify({ schema: "boundary-display-v1", count: 0, pages: [] }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  overlay.update([0, 0, 1, 1], 4, true);
  expect(calls).toBe(1);
  expect(changed).toBe(0);
});

test("regional views retain screen-scale border detail and refine after zooming", async () => {
  const pages = Array.from({ length: 90 }, (_, i) => ({
    key: `boundary-display/16/0/${i}`,
    level: 6,
    bbox: [i * 2, 0, i * 2 + 1, 1],
    count: 1,
  }));
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  let reads = 0,
    rawBytes = 0,
    zoom = 5;
  let view: [number, number, number, number] = [0, 0, 1, 1];
  const errors: string[] = [];
  const reader = {
    index: { manifest },
    block: async (key: string) => {
      reads++;
      if (key === BORDER_ROOT)
        return encode({
          schema: "boundary-display-v1",
          count: pages.length,
          pages,
        });
      const page = pages.find((p) => p.key === key)!;
      const lines = [
        Array.from({ length: 3000 }, (_, i) => [
          page.bbox[0]! + i / 2999,
          0.123456789 + (i % 2) * 0.0001,
        ]),
      ];
      const bytes = encode({
        schema: "boundary-lines-v1",
        borders: [{ id: key, level: 6, bbox: page.bbox, lines }],
      });
      rawBytes += bytes.length;
      return bytes;
    },
  } as unknown as AtlasReader;
  const overlay = new BorderOverlay(
    reader,
    () => overlay.update(view, zoom, true),
    (e) => errors.push(e),
  );
  const settle = async () => {
    for (let i = 0; i < 2000 && overlay.loading; i++) await Promise.resolve();
    expect(overlay.loading).toBe(0);
  };
  const vertices = () => {
    let count = 0;
    const noop = () => {};
    const canvas = {
      save: noop,
      restore: noop,
      beginPath: noop,
      setLineDash: noop,
      stroke: noop,
      moveTo: () => count++,
      lineTo: () => count++,
    } as unknown as CanvasRenderingContext2D;
    overlay.draw(
      canvas,
      {
        center: [0.5, 0.5],
        zoom,
        width: 1000,
        height: 800,
        pitch: 0,
        bearing: 0,
      },
      PAPER,
    );
    return count;
  };
  overlay.update(view, zoom, true);
  await settle();
  expect(reads).toBe(91);
  expect(rawBytes * 3).toBeGreaterThan(24 * 1024 ** 2);
  expect(errors).toEqual([]);
  expect(vertices()).toBeLessThan(1000);
  const nw = project(-0.1, 1.1),
    se = project(1.1, -0.1);
  view = [nw[0], nw[1], se[0], se[1]];
  zoom = 14;
  overlay.update(view, zoom, true);
  await settle();
  expect(reads).toBe(92);
  expect(vertices()).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
  const west = project(1.9, 1.1),
    east = project(3.1, -0.1);
  view = [west[0], west[1], east[0], east[1]];
  overlay.update(view, zoom, true);
  await settle();
  expect(reads).toBe(93);
  expect(vertices()).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
  overlay.destroy();
});

test("viewport clipping preserves separate border strokes without joining outside segments", () => {
  const nw = project(-1, 1),
    se = project(1, -1);
  const lines = clipBorderLines(
    [
      [
        [-2, 0],
        [2, 0],
        [2, 2],
        [-2, 2],
        [-2, 0.5],
        [2, 0.5],
      ],
    ],
    [nw[0], nw[1], se[0], se[1]],
  );
  expect(lines).toHaveLength(2);
  expect(lines[0]![0]![0]).toBeCloseTo(-1, 8);
  expect(lines[0]!.at(-1)![0]).toBeCloseTo(1, 8);
  expect(lines[1]![0]![1]).toBeCloseTo(0.5, 8);
  expect(
    lines
      .flat()
      .every(
        ([x, y]) =>
          x >= -1.00000001 &&
          x <= 1.00000001 &&
          y >= -1.00000001 &&
          y <= 1.00000001,
      ),
  ).toBe(true);
});
