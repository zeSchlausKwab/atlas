import {
  publishedHost,
  discoverPublishedHost,
} from "../tests/helpers/published-host";
import { HashtreeSource } from "../packages/hashtree/src/source";
import { verifyPublishedMap } from "../packages/hashtree/src/published-map";
/** Real-data rehearsal: three independent PBF compilations; two independent Nostr/Hashtree publishers.
 * Run after verify:routing-federation; requires the local Liechtenstein PBF.
 * All scratch files and servers are removed, including after a failed assertion. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { encodePackage, type InputBlock } from "../packages/format/src/writer";
import { TRANSPORT_MODES, type Manifest } from "../packages/format/src/index";
import { routingAuthority } from "../packages/cli/src/routing-authority";
import { fileHash } from "../packages/cli/src/source";
import { addPartitionedTransport } from "../packages/cli/src/transport-partitioned";
import { RoutingComposition } from "../packages/routing/src/composition";
import { PagedRouter } from "../packages/routing/src/paged";
import { initSync } from "../packages/routing/pkg/atlas_routing_wasm";
const input = process.argv[2] ?? "data/liechtenstein.osm.pbf";
const authority = await fileHash(input);
const work = await mkdtemp("/tmp/atlas-osm-federation-");
const readers: AtlasReader[] = [],
  servers: Awaited<ReturnType<typeof publishedHost>>[] = [],
  routers: PagedRouter[] = [];
async function build(name: string, bounds: [number, number, number, number]) {
  const pbf = `${work}/${name}.osm.pbf`;
  const extract = Bun.spawn(
    [
      "osmium",
      "extract",
      input,
      `--bbox=${bounds.join(",")}`,
      "--strategy=smart",
      "-S",
      "types=multipolygon,restriction",
      "-o",
      pbf,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  assert.equal(await extract.exited, 0);
  const source = {
    url: input,
    sha256: authority,
    attribution: "OpenStreetMap contributors",
    inputs: [{ url: input, sha256: authority, bytes: Bun.file(input).size }],
    extraction: {
      bounds,
      strategy: "smart; types=multipolygon,restriction",
      sourceDate: "fixture",
    },
  };
  const blocks: InputBlock[] = [];
  const transport = await addPartitionedTransport(
    {
      async add(b) {
        blocks.push(b);
      },
    },
    pbf,
    `${work}/${name}`,
    TRANSPORT_MODES,
    undefined,
    () => {},
    await fileHash(pbf),
    routingAuthority(source),
  );
  const manifest: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name,
    source,
    bounds,
    minZoom: 0,
    maxZoom: 0,
    features: 0,
    peaks: 0,
    places: [],
    capabilities: ["transport-routing"],
    limitations: [],
    transport,
  };
  const bytes = await encodePackage(manifest, blocks, { paged: true });
  console.log(
    `${name}: ${blocks.length} cells, ${bytes.length} bytes, independent PBF ${await fileHash(pbf)}`,
  );
  await rm(`${work}/${name}`, { recursive: true, force: true });
  return bytes;
}
async function serve(bytes: Uint8Array) {
  const id = servers.length;
  const path = `${work}/host-${id}.atlas`;
  await Bun.write(path, bytes);
  const host = await publishedHost(path, `${work}/host-${id}-discovery`);
  servers.push(host);
  const offer = await discoverPublishedHost(host);
  const reader = await new AtlasReader(
    new HashtreeSource(offer.url, offer.hashtree!, offer.api),
  ).open();
  verifyPublishedMap(offer, reader);
  readers.push(reader);
  return { id: host.pubkey, reader, requests: () => host.stats().blobRequests };
}
try {
  initSync({
    module: await Bun.file(
      "packages/routing/pkg/atlas_routing_wasm_bg.wasm",
    ).arrayBuffer(),
  });
  const whole = await build("whole", [9.3, 46.9, 9.85, 47.5]);
  const south = await serve(await build("south", [9.3, 46.9, 9.85, 47.17]));
  const north = await serve(await build("north", [9.3, 47.1, 9.85, 47.5]));
  const refReader = await new AtlasReader(
    new FileSource(new Blob([whole as Uint8Array<ArrayBuffer>])),
  ).open();
  readers.push(refReader);
  const pair = new RoutingComposition([south, north]),
    reference = new RoutingComposition([{ id: "whole", reader: refReader }]);
  const router = (c: RoutingComposition) => {
    const r = new PagedRouter(
      c.snapshot,
      (k) => c.read(k),
      () => {},
      async () => {},
      { searchStates: 2_000_000 },
    );
    routers.push(r);
    return r;
  };
  const a = router(pair),
    b = router(reference);
  for (const mode of TRANSPORT_MODES) {
    const start: [number, number] = [9.503, 47.066],
      end: [number, number] = [9.522, 47.212];
    const expected = await b.route(start, end, mode, reference.prefix(mode));
    const actual = await a.route(start, end, mode, pair.prefix(mode));
    assert.equal(actual.status, "found", JSON.stringify(actual));
    assert.equal(expected.status, "found", JSON.stringify(expected));
    if (actual.status !== "found" || expected.status !== "found")
      throw Error("Route missing");
    assert.equal(actual.seconds, expected.seconds);
    assert.deepEqual(actual.wayIds, expected.wayIds);
    assert.deepEqual(actual.coordinates, expected.coordinates);
    console.log(
      `${mode}: ${Math.round(actual.meters!)} m, ${actual.seconds!.toFixed(2)} s; matches independent reference`,
    );
  }
  assert.equal(new Set([...pair.served.values()].map((v) => v.source)).size, 2);
  const reads = south.requests() + north.requests();
  for (const r of [south.reader, north.reader]) r.offline = true;
  for (const s of servers) await s.close();
  assert.equal(
    (
      await a.route(
        [9.503, 47.066],
        [9.522, 47.212],
        "driving",
        pair.prefix("driving"),
      )
    ).status,
    "found",
  );
  assert.equal(south.requests() + north.requests(), reads);
  console.log(
    JSON.stringify({
      passed: true,
      sourceRevision: authority,
      providers: 2,
      hashtreeRequests: reads,
      publishers: servers.map((h) => h.pubkey),
      rawRangeRequests: servers.reduce((n, h) => n + h.stats().rawRequests, 0),
      cells: pair.served.size,
      offlineReplay: true,
    }),
  );
} finally {
  for (const r of routers) r.destroy();
  for (const r of readers) r.dispose();
  for (const s of servers) await s.close();
  await rm(work, { recursive: true, force: true });
}
