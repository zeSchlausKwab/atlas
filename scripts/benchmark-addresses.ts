import { mkdtemp, rm } from "node:fs/promises";
import { buildGeocoding } from "../packages/geocoding/src/compile";
import {
  addressText,
  SEMANTIC_RETENTION,
  type Location,
} from "../packages/geocoding/src/model";
import { PagedSearchBuilder } from "../packages/geocoding/src/paged-build";
import { StreamWriter } from "../packages/cli/src/stream-writer";
import type { Manifest } from "../packages/format/src/index";
const input = process.argv[2] ?? "data/liechtenstein.osm.pbf";
const dir = await mkdtemp("/tmp/atlas-address-cost-");
try {
  const importer = Bun.spawn(
    [
      "target/release/atlas-osm-import",
      input,
      `${dir}/source.json`,
      "--no-legacy-routing",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await importer.exited)
    throw Error("Build the current Rust importer first.");
  const source = await Bun.file(`${dir}/source.json`).json();
  const all = buildGeocoding(source.locations, source.geojson).locations
    .records;
  // Isolate explicit address cost while retaining the new POI coverage in both variants.
  const without: Location[] = all
    .filter((r) => r.kind !== "address")
    .map((r) => {
      if (!r.address) return r;
      const { address, ...rest } = r;
      return {
        ...rest,
        name:
          r.tags?.name ||
          (r.name === addressText(address) ? r.category : r.name),
        aliases: r.aliases.filter((a) => a !== addressText(address)),
        tags: r.tags
          ? Object.fromEntries(
              Object.entries(r.tags).filter(([k]) => !k.startsWith("addr:")),
            )
          : undefined,
      };
    });
  const report = [];
  for (const [name, records] of [
    ["without-addresses", without],
    ["with-addresses", all],
  ] as const) {
    const start = performance.now(),
      builder = new PagedSearchBuilder(`${dir}/${name}.sqlite`),
      writer = await new StreamWriter(
        `${dir}/${name}.atlas`,
        256 * 1024 ** 2,
      ).open();
    try {
      for (const r of records) builder.addLocation(r);
      await builder.finish(writer, { search: true, reverse: false });
      const m: Omit<Manifest, "snapshot"> = {
        format: "atlas",
        version: 1,
        name,
        source: {
          url: input,
          sha256: "0".repeat(64),
          attribution: "OpenStreetMap contributors",
        },
        bounds: [-180, -85, 180, 85],
        minZoom: 0,
        maxZoom: 0,
        features: 0,
        peaks: 0,
        places: [],
        capabilities: ["location-search"],
        limitations: [],
        semantics: SEMANTIC_RETENTION,
      };
      await writer.finish(m);
      report.push({
        variant: name,
        records: records.length,
        bytes: Bun.file(`${dir}/${name}.atlas`).size,
        buildMs: Math.round(performance.now() - start),
      });
    } finally {
      await builder.dispose();
    }
  }
  const addresses = all.filter((r) => r.address).length;
  console.log(
    JSON.stringify(
      {
        input,
        explicitAddressRecords: addresses,
        variants: report,
        additionalBytes: report[1]!.bytes - report[0]!.bytes,
        bytesPerAddress: (report[1]!.bytes - report[0]!.bytes) / addresses,
        scope:
          "Search archive only; same POI coverage in both variants. Not a planet-size extrapolation.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
