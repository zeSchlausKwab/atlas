import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { compilePartitioned } from "../packages/cli/src/partitioned";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { AtlasGeocoder, locations } from "../packages/geocoding/src/index";
import { AtlasWorkspace } from "../packages/workspace/src/index";
import { MAP_LAYERS } from "../packages/format/src/index";
import { FEATURE_KINDS } from "../packages/features/src/index";
const dir = await mkdtemp("/tmp/atlas-workspace-build-");
try {
  await compilePartitioned({
    input: process.argv[2] ?? "data/liechtenstein.osm.pbf",
    output: `${dir}/sample.atlas`,
    work: `${dir}/work`,
    reserveBytes: 0,
    workers: 2,
    selection: {
      snapshot: "0".repeat(64),
      name: "Workspace integration",
      polygon: [
        [9.45, 47.04],
        [9.66, 47.04],
        [9.66, 47.28],
        [9.45, 47.28],
      ],
      minZoom: 0,
      maxZoom: 16,
      layers: [...MAP_LAYERS],
      placeNames: true,
      streetNames: true,
      pois: true,
      profiles: ["walking", "cycling", "driving"],
      search: true,
      reverse: true,
      peaks: true,
      featureKinds: [...FEATURE_KINDS],
      paddingCells: 1,
      maxBytes: 512 * 1024 ** 2,
    },
  });
  const reader = await new AtlasReader(
    new FileSource(Bun.file(`${dir}/sample.atlas`)),
  ).open();
  assert.equal(reader.index.manifest.semantics?.addresses, "osm-explicit");
  assert(reader.index.manifest.capabilities.includes("address-search"));
  let address;
  for await (const b of reader.iterateBlocks()) {
    if (b.key.startsWith("search/records/")) {
      address = locations(await reader.block(b.key))
        .map((r) => r.record)
        .find((r) => r.address?.street);
      if (address) break;
    }
  }
  assert(address?.address);
  const search = await new AtlasGeocoder(reader).search(
    `${address.address.street} ${address.address.houseNumber}`,
  );
  assert(
    search.matches.some(
      (r) => r.address?.houseNumber === address!.address!.houseNumber,
    ),
  );
  const [x, y] = address.coordinates,
    w = new AtlasWorkspace([reader]);
  const prepared = await w.prepare({
    bounds: [x - 0.003, y - 0.003, x + 0.003, y + 0.003],
    families: ["locations", "buildings"],
  });
  reader.dispose();
  assert(
    w.query({ workspace: prepared.workspace, ids: [address.id] }).count > 0,
  );
  console.log(
    JSON.stringify({
      fileBytes: Bun.file(`${dir}/sample.atlas`).size,
      address: address.address,
      prepared,
      queryAfterClosingSource: true,
    }),
  );
  w.clear();
} finally {
  await rm(dir, { recursive: true, force: true });
}
