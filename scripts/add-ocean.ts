import { writeOceanObjects } from "../packages/objects/src/ocean";
/** Add independently assembled OSM ocean polygons without rebuilding a PBF.
 * Usage: bun scripts/add-ocean.ts INPUT.atlas CLIPPED.geojson OUTPUT.atlas SOURCE.json
 * SOURCE.json: {url, sha256, bytes}, from the verified coastline download.
 * Writes a new archive; publication/replacement remains an explicit next step.
 */
import { resolve } from "node:path";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { sha256 } from "../packages/format/src/index";
import { WaterPatchWriter } from "../packages/cli/src/water-patch";
import { oceanTiles } from "../packages/cli/src/ocean-tiles";
const [input, geojson, output, metadata] = process.argv.slice(2);
if (
  !input ||
  !geojson ||
  !output ||
  !metadata ||
  resolve(input) === resolve(output)
)
  throw Error(
    "Usage: bun scripts/add-ocean.ts INPUT.atlas CLIPPED.geojson NEW.atlas SOURCE.json",
  );
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    controller.abort(
      Error("Ocean preparation stopped; original map is unchanged"),
    ),
  );
const log = (s: string) => console.log(new Date().toISOString(), s);
const file = Bun.file(geojson);
if (file.size > 256 * 1024 ** 2)
  throw Error("Clipped ocean input exceeds 256 MiB regional budget");
const source = await Bun.file(metadata).json();
if (
  typeof source.url !== "string" ||
  !/^[a-f0-9]{64}$/.test(source.sha256) ||
  !Number.isSafeInteger(source.bytes) ||
  source.bytes <= 0
)
  throw Error("Invalid coastline source metadata");
const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
const writer = new WaterPatchWriter(
  reader,
  output,
  32 * 1024 ** 3,
  controller.signal,
  log,
);
try {
  const { snapshot, ...manifest } = reader.index.manifest;
  if (
    manifest.limitations.some((s) =>
      s.startsWith("Ocean display polygons added"),
    )
  )
    throw Error(
      "This package already has ocean polygons; patch its original instead",
    );
  const bytes = await file.bytes(),
    data = JSON.parse(new TextDecoder().decode(bytes));
  await writer.open();
  log("Tiling ocean polygons at every package zoom; retaining inland water");
  let count = 0;
  const start = performance.now();
  await oceanTiles(data, manifest, controller.signal, async (tile) => {
    await writer.add(tile);
    if (++count % 10000 === 0)
      log(
        `${count} water tiles · ${(count / ((performance.now() - start) / 1000)).toFixed(0)} tiles/s · ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MiB RSS`,
      );
  });
  if (!count) throw Error("No ocean tiles intersect this map");
  await writeOceanObjects(
    reader,
    { add: (b) => writer.addObjectBlock(b) },
    data,
    source.sha256,
    controller.signal,
    log,
  );
  const size = await writer.finish({
    ...manifest,
    featureZoom: manifest.featureZoom ?? 12,
    featureKinds: [
      ...new Set([...(manifest.featureKinds ?? []), "objects" as const]),
    ],
    capabilities: [
      ...new Set([
        ...manifest.capabilities,
        "source-objects",
        "feature-extraction",
        "land-sea-surfaces",
      ]),
    ],
    source: {
      ...manifest.source,
      inputs: [
        ...(manifest.source.inputs ?? [
          {
            url: manifest.source.url,
            sha256: manifest.source.sha256,
            bytes: 0,
          },
        ]),
        { url: source.url, sha256: source.sha256, bytes: source.bytes },
        {
          url: `atlas:clipped-ocean:${snapshot}`,
          sha256: await sha256(bytes),
          bytes: bytes.length,
        },
      ],
    },
    limitations: [
      ...manifest.limitations,
      `Ocean display polygons added from a separately dated OSM coastline snapshot (${source.sha256.slice(0, 16)}). Queryable sea surfaces carry their own source fingerprint; physical coastline ways and routing retain the original PBF snapshot.`,
    ],
  });
  log(
    `Complete: ${count} ocean tiles, ${size} archive bytes, output ${output}`,
  );
} catch (error) {
  await writer.abort();
  throw error;
} finally {
  reader.dispose();
}
