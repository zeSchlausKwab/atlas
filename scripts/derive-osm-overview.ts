#!/usr/bin/env bun
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { preparePackage } from "../packages/provisioning/src/prepare";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: bun scripts/derive-osm-overview.ts WORLD.atlas NEW.atlas",
  );
if (await Bun.file(output).exists())
  throw new Error("Choose a new output path");
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
const reader = await new AtlasReader(new FileSource(Bun.file(input))).open();
try {
  const m = reader.index.manifest,
    [w, s, e, n] = m.bounds;
  if (
    w > -179 ||
    e < 179 ||
    s > -84 ||
    n < 84 ||
    !m.capabilities.includes("administrative-boundaries") ||
    ![m.source, ...(m.source.inputs ?? [])].some((s) =>
      s.url.includes(".osm.pbf"),
    )
  )
    throw new Error(
      "Use an OSM-derived world archive with retained administrative polygons",
    );
  let last = 0;
  console.log(
    await preparePackage(
      reader,
      {
        snapshot: m.snapshot,
        name: "World overview · OSM",
        polygon: [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
        ],
        minZoom: 0,
        maxZoom: Math.min(4, m.maxZoom),
        layers: (m.tileLayers ?? []).filter(
          (l) => l === "water" || l === "land",
        ),
        placeNames: true,
        streetNames: false,
        pois: false,
        profiles: [],
        search: false,
        reverse: false,
        peaks: false,
        featureKinds: ["boundaries"],
        boundaryMaxAdminLevel: 2,
        paddingCells: 0,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      output,
      abort.signal,
      (p) => {
        if (performance.now() - last > 1000) {
          console.log(p.message, p.completed, p.total);
          last = performance.now();
        }
      },
    ),
  );
} finally {
  reader.dispose();
}
