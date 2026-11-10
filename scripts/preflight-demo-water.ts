/** Real coastline → display bytes, before spending hours on PBF compilation.
 * ATLAS_OCEAN_SOURCE=... bun scripts/preflight-demo-water.ts WORK_DIRECTORY
 * Also probes Madeira to prevent repeating the missing-island-sea demo.
 */
import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import recipe from "../recipes/north-sea-demo.json";
import {
  configuredOcean,
  prepareOcean,
} from "../packages/provisioning/src/ocean-source";
import { oceanTiles } from "../packages/cli/src/ocean-tiles";
import { coversWater } from "./lib/water-probe";
import { project, type Manifest } from "../packages/format/src/index";
import type { PackageSelection } from "../packages/provisioning/src/selection";
const work = process.argv[2];
if (!work) throw Error("Supply a preflight working directory");
const source = await configuredOcean();
if (!source) throw Error("Configure ATLAS_OCEAN_SOURCE first");
const maps = [
  ...recipe.maps,
  {
    key: "madeira",
    name: "Madeira sea regression",
    bounds: [-17.3545528, 32.5277486, -16.6162097, 32.9720222],
    probes: [
      { name: "Sea south of Madeira", point: [-16.9, 32.55], water: true },
      { name: "Madeira island land", point: [-16.95, 32.72], water: false },
    ],
  },
];
const signal = new AbortController().signal;
const report: unknown[] = [];
for (const m of maps) {
  const [w, s, e, n] = m.bounds;
  const polygon: [number, number][] = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
  const selection: PackageSelection = {
    name: m.name,
    snapshot: "coastline-preflight",
    polygon,
    minZoom: 0,
    maxZoom: 16,
    ocean: { sha256: source.sha256 },
    layers: ["water"],
    profiles: [],
    featureKinds: [],
    placeNames: false,
    streetNames: false,
    pois: false,
    search: false,
    reverse: false,
    peaks: false,
    paddingCells: 0,
    maxBytes: Number.MAX_SAFE_INTEGER,
  };
  const ocean = await prepareOcean(
    selection,
    join(resolve(work), m.key),
    signal,
    (line) => console.log(`${m.key}: ${line}`),
  );
  assert.ok(
    ocean?.data.features.length,
    `${m.key}: coastline source contains sea surfaces`,
  );
  const checks: unknown[] = [];
  for (const p of m.probes) {
    const point = p.point as [number, number];
    const found = new Map<number, boolean>();
    // Traverse only the tiles containing this test point, at every zoom, through
    // the production ocean tiler/compactor. This does not generate a full z16 map.
    const delta = 0.00001;
    const selection: NonNullable<Manifest["selection"]> = {
      polygon: [
        [point[0] - delta, point[1] - delta],
        [point[0] + delta, point[1] - delta],
        [point[0] + delta, point[1] + delta],
        [point[0] - delta, point[1] + delta],
      ],
      parentSnapshot: "preflight",
      boundaryPolicy: "probe",
    };
    await oceanTiles(
      ocean.data,
      {
        bounds: m.bounds as Manifest["bounds"],
        minZoom: 0,
        maxZoom: 16,
        selection,
      },
      signal,
      async (tile) => {
        const z = tile.z!,
          [x, y] = project(...point).map((v) => Math.floor(v * 2 ** z));
        if (tile.x === x && tile.y === y)
          found.set(z, coversWater(tile.bytes, point, z, x, y));
      },
    );
    // At overview zooms the island may intentionally be generalized away.
    for (const z of [8, 10, 12, 14, 16]) {
      assert.equal(found.get(z) ?? false, p.water, `${p.name}: water at z${z}`);
      checks.push({ name: p.name, point, z, water: found.get(z) ?? false });
    }
    console.log(`${m.key}: PASS ${p.name} at z8,10,12,14,16`);
  }
  report.push({
    key: m.key,
    sourceSha256: source.sha256,
    clipSha256: ocean.clipHash,
    clipBytes: ocean.clipBytes,
    polygons: ocean.data.features.length,
    checks,
  });
}
await mkdir(resolve(work), { recursive: true });
await Bun.write(
  join(resolve(work), "water-preflight.json"),
  JSON.stringify({ at: new Date().toISOString(), maps: report }, null, 2),
);
console.log(
  "Sea fill and land exclusion passed for all three regions and Madeira.",
);
