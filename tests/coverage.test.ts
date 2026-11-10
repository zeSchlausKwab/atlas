import { expect, test } from "bun:test";
import {
  planCoverage,
  coverageFamilies,
  type CoverageSource,
} from "../packages/coverage/src/index";
import { inspectRouting } from "../packages/coverage/src/routing-inspection";
import { unproject, type Manifest } from "../packages/format/src/index";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage } from "../packages/format/src/writer";
import type { Polygon } from "../packages/offline/src/geometry";
const box = (w: number, s: number, e: number, n: number): Polygon => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
];
const manifest = (bounds: Manifest["bounds"] = [0, 0, 4, 4]): Manifest => ({
  format: "atlas",
  version: 1,
  name: "Coverage fixture",
  snapshot: "a".repeat(64),
  source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
  bounds,
  minZoom: 0,
  maxZoom: 16,
  features: 0,
  peaks: 0,
  places: [],
  capabilities: ["vector-rendering"],
  tileLayers: ["water"],
  limitations: [],
});
const source = (
  id: string,
  bounds: Manifest["bounds"],
  location: CoverageSource["location"] = "local",
  verified = true,
): CoverageSource => ({
  id,
  manifest: manifest(bounds),
  location,
  verified,
  bytes: 100,
});
const req = { polygon: box(0, 0, 4, 4), family: "tile:water", zoom: 14 };
test("coverage partitions overlapping local, remote, unknown, and missing scope without double counting", () => {
  const r = planCoverage(req, [
    source("a", [0, 0, 1, 4]),
    source("b", [0, 0, 2, 4], "remote"),
    source("c", [2, 0, 3, 4], "remote", false),
  ]);
  for (const state of ["local", "remote", "unknown", "missing"] as const)
    expect(r.totals[state] / r.areaM2).toBeCloseTo(0.25, 6);
  expect(Object.values(r.totals).reduce((a, b) => a + b, 0)).toBeCloseTo(
    r.areaM2,
    2,
  );
  expect(r.fullArchiveDownloadBytes).toBe(100);
  expect(r.providers).toHaveLength(3);
});
test("polygon selection, zoom and absent capabilities do not inherit a bounding box claim", () => {
  const s = source("triangle", [0, 0, 4, 4]);
  s.manifest.selection = {
    polygon: [
      [0, 0],
      [4, 0],
      [0, 4],
    ],
    parentSnapshot: "b".repeat(64),
    boundaryPolicy: "intersects",
    routingPaddingCells: 0,
  };
  const r = planCoverage(req, [s]);
  expect(r.totals.missing).toBeGreaterThan(0);
  expect(r.totals.local / r.areaM2).toBeCloseTo(0.5, 2);
  expect(planCoverage({ ...req, zoom: 17 }, [s]).totals.local).toBe(0);
  expect(
    planCoverage({ ...req, family: "addresses" }, [s]).totals.missing,
  ).toBeCloseTo(r.areaM2, 3);
  expect(() =>
    planCoverage({ ...req, polygon: box(-170, 0, 170, 20) }, [s]),
  ).toThrow("Date-line");
});
test("address search is claimed only with explicit retained addresses and location search", () => {
  const m = manifest();
  expect(coverageFamilies(m).map((f) => f.id)).not.toContain("addresses");
  m.capabilities.push("location-search");
  expect(coverageFamilies(m).map((f) => f.id)).not.toContain("addresses");
  m.semantics = { addresses: "osm-explicit" } as Manifest["semantics"];
  expect(coverageFamilies(m).map((f) => f.id)).toContain("addresses");
});
function transport(m: Manifest, revision = "b".repeat(64)) {
  m.capabilities = ["transport-routing"];
  m.transport = {
    version: 1,
    federation: {
      version: 1,
      namespace: "openstreetmap",
      sourceRevision: revision,
      contract: "atlas-osm-transport-v1",
      segmentIdentity: "osm-way-segment-v1",
      completeBounds: [...m.bounds],
    },
    profiles: {
      walking: {
        prefix: "routing/walking/cells",
        zoom: 14,
        codec: "rcl3",
        count: 0,
        nodes: 0,
        segments: 0,
        turns: 0,
        skippedWays: 0,
        unsupportedRestrictions: 0,
        excludedRestrictionWays: 0,
      },
    },
  };
  return m;
}
test("independent routing snapshots are incompatible and partial cells are excluded", () => {
  const a = source("a", [0, 0, 2, 4]),
    b = source("b", [2, 0, 4, 4], "remote");
  transport(a.manifest);
  transport(b.manifest, "c".repeat(64));
  const r = planCoverage(
    { ...req, family: "routing:walking", reference: "a" },
    [a, b],
  );
  expect(r.totals.local).toBeGreaterThan(0);
  expect(r.totals.incompatible).toBeGreaterThan(0);
  expect(r.totals.remote).toBe(0);
  expect(r.totals.missing).toBeGreaterThan(0);
  expect(r.totals.local / r.areaM2).toBeLessThan(0.5);
  transport(b.manifest);
  expect(
    planCoverage({ ...req, family: "routing:walking" }, [a, b]).totals.remote,
  ).toBeGreaterThan(0);
});
test("whole-file mirror estimate deduplicates roots", () => {
  const a = source("a", [0, 0, 2, 4], "remote"),
    b = source("b", [2, 0, 4, 4], "remote");
  a.root = b.root = "f".repeat(64);
  expect(planCoverage(req, [a, b]).fullArchiveDownloadBytes).toBe(100);
});
const x = 8900,
  y = 5700,
  n = 16384;
function cellArea(x: number, y: number) {
  const sw = unproject((x + 0.1) / n, (y + 0.9) / n),
    ne = unproject((x + 0.9) / n, (y + 0.1) / n);
  return box(sw[0], sw[1], ne[0], ne[1]);
}
async function routingReader(value?: number, revision = "b".repeat(64)) {
  const sw = unproject((x - 2) / n, (y + 3) / n),
    ne = unproject((x + 3) / n, (y - 2) / n),
    m = transport(manifest([...sw, ...ne]), revision);
  m.transport!.profiles.walking!.count = value === undefined ? 0 : 1;
  const bytes = await encodePackage(
    m,
    value === undefined
      ? []
      : [
          {
            key: `routing/walking/cells/14/${x}/${y}`,
            bytes: new Uint8Array([value]),
          },
        ],
    { paged: true },
  );
  return new AtlasReader(new FileSource(new Blob([bytes]))).open();
}
test("directory inspection separates present, verified empty, conflict, incompatible and missing cells", async () => {
  const a = await routingReader(1),
    b = await routingReader(2),
    c = await routingReader(1, "c".repeat(64));
  try {
    const single = await inspectRouting(
      cellArea(x, y),
      "walking",
      [{ id: "a", reader: a }],
      "a",
    );
    expect(single.counts.present).toBe(1);
    expect(single.payloadsChecked).toBe(false);
    expect(
      (
        await inspectRouting(
          cellArea(x + 1, y),
          "walking",
          [{ id: "a", reader: a }],
          "a",
        )
      ).counts.empty,
    ).toBe(1);
    expect(
      (
        await inspectRouting(
          cellArea(x + 4, y),
          "walking",
          [{ id: "a", reader: a }],
          "a",
        )
      ).counts.missing,
    ).toBe(1);
    expect(
      (
        await inspectRouting(
          cellArea(x, y),
          "walking",
          [
            { id: "a", reader: a },
            { id: "b", reader: b },
          ],
          "a",
        )
      ).counts.conflict,
    ).toBe(1);
    expect(
      (
        await inspectRouting(
          cellArea(x, y),
          "walking",
          [
            { id: "a", reader: a },
            { id: "c", reader: c },
          ],
          "a",
        )
      ).counts.present,
    ).toBe(1);
    await expect(
      inspectRouting(cellArea(x, y), "walking", [], "a"),
    ).rejects.toThrow("reference");
    await expect(
      inspectRouting(req.polygon, "walking", [{ id: "a", reader: a }], "a"),
    ).rejects.toThrow("smaller area");
  } finally {
    a.dispose();
    b.dispose();
    c.dispose();
  }
});
test("a failed routing directory cannot be reported as an empty cell", async () => {
  const a = await routingReader();
  try {
    a.spatial = async () => {
      throw Error("host offline");
    };
    expect(
      (
        await inspectRouting(
          cellArea(x, y),
          "walking",
          [{ id: "a", reader: a }],
          "a",
        )
      ).counts.unknown,
    ).toBe(1);
  } finally {
    a.dispose();
  }
});

test("extraction types are independent and unavailable offers stay unknown during routing inspection", async () => {
  const a = source("a", [0, 0, 4, 4]);
  a.manifest.featureKinds = ["water"];
  a.manifest.capabilities.push("feature-extraction");
  expect(
    planCoverage({ ...req, family: "features:water" }, [a]).totals.local,
  ).toBeGreaterThan(0);
  expect(
    planCoverage({ ...req, family: "features:buildings" }, [a]).totals.local,
  ).toBe(0);
  const reader = await routingReader();
  let reference: AtlasReader | undefined;
  try {
    const outside = structuredClone(reader.index.manifest);
    outside.bounds = [0, 0, 1, 1];
    outside.transport!.federation!.completeBounds = [0, 0, 1, 1];
    reference = await new AtlasReader(
      new FileSource(new Blob([await encodePackage(outside, [])])),
    ).open();
    const result = await inspectRouting(
      cellArea(x, y),
      "walking",
      [
        {
          id: "reference",
          reader: reference,
        },
        { id: "offline", manifest: reader.index.manifest },
      ],
      "reference",
    );
    expect(result.counts.unknown).toBe(1);
    expect(result.counts.missing).toBe(0);
  } finally {
    reader.dispose();
    reference?.dispose();
  }
});
