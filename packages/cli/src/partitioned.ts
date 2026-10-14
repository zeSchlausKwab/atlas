import { compilerWorkers } from "../../compiler/src/settings";
import { Database } from "bun:sqlite";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature, Polygon as GeoPolygon } from "geojson";
import booleanIntersects from "@turf/boolean-intersects";
import { StreamWriter, type BlockWriter } from "./stream-writer";
import { BlockSpool } from "./block-spool";
import { partitionTiles } from "./partitioned-tiles";
import { addPartitionedTransport } from "./transport-partitioned";
import { fileHash } from "./source";
import { AtlasReader, FileSource } from "../../format/src/reader";
import {
  project,
  type Manifest,
  type Peak,
  type Place,
  type TransportMode,
} from "../../format/src/index";
import { buildingHeight } from "../../format/src/heights";
import { SourceGeocoding } from "../../geocoding/src/source-build";
import { PagedSearchBuilder } from "../../geocoding/src/paged-build";
import { buildLabels, partitionLabels } from "../../labels/src/compile";
import { LABEL_ZOOM } from "../../labels/src/index";
import { buildFeatures } from "../../features/src/compile";
import { FEATURE_ZOOM } from "../../features/src/index";
import { inside, bounds, selectedCell } from "../../offline/src/geometry";
import { clipLine } from "../../provisioning/src/prepare";
import type { PackageSelection } from "../../provisioning/src/selection";
import { runCompiler } from "../../provisioning/src/process";
import { measuredProgress } from "../../provisioning/src/compiler-progress";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VERSION = 3;
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
interface State {
  identity: string;
  completed: Record<string, { size: number; sha256: string }>;
}
export interface PartitionedOptions {
  input: string;
  output: string;
  work: string;
  selection: PackageSelection;
  source?: Manifest["source"];
  signal?: AbortSignal;
  progress?: (message: string) => void;
  reserveBytes?: number;
  workers?: number;
}
/** Whole-source identity and durable stage artifacts; no per-partition graph identities. */
export async function compilePartitioned(o: PartitionedOptions) {
  const workers = compilerWorkers(o.workers);
  const s = o.selection,
    progress = o.progress ?? console.log,
    abort = new AbortController(),
    signal = o.signal
      ? AbortSignal.any([o.signal, abort.signal])
      : abort.signal;
  await mkdir(o.work, { recursive: true });
  await mkdir(dirname(o.output), { recursive: true });
  const inputHash = await fileHash(
      o.input,
      (completed, total) =>
        progress(
          "ATLAS_PROGRESS " +
            JSON.stringify({
              stage: "input-verification",
              message: "Verifying compiler input",
              completed,
              total,
              unit: "bytes",
            }),
        ),
      signal,
    ),
    identity = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify({ version: VERSION, inputHash, selection: s }))
      .digest("hex");
  const statePath = join(o.work, "partitioned.json"),
    old = Bun.file(statePath);
  const state: State = (await old.exists())
    ? await old.json()
    : { identity, completed: {} };
  if (state.identity !== identity)
    throw new Error(
      "Partitioned checkpoints belong to another source, recipe or compiler",
    );
  let failure: Error | undefined;
  const space = async () => {
    const fs = await statfs(o.work);
    if (fs.bavail * fs.bsize < (o.reserveBytes ?? 2 * 1024 ** 3)) {
      failure = new Error(
        "Build paused at the free-space reserve. Completed stages remain available for resume.",
      );
      abort.abort();
      throw failure;
    }
  };
  const timer = setInterval(() => void space().catch(() => {}), 2000);
  const base: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name: s.name,
    source: o.source ?? {
      url: o.input,
      sha256: inputHash,
      attribution: "© OpenStreetMap contributors · ODbL",
    },
    bounds: bounds(s.polygon),
    minZoom: s.minZoom,
    maxZoom: s.maxZoom,
    features: 0,
    peaks: 0,
    places: [],
    capabilities: [],
    limitations: [
      "Prototype compiler: bounded source batches and spatial graph/search pages.",
      "Estimated transport costs; common via-node restrictions. Unsupported conditional/complex restrictions exclude incoming ways.",
      "Search covers retained OSM names and nearby streets, not house-number addresses. Very broad text queries have a bounded candidate budget.",
      "Whole display tiles and extractable source objects can extend outside the polygon; routing uses padded whole cells.",
    ],
    selection: {
      polygon: s.polygon,
      parentSnapshot: inputHash,
      boundaryPolicy:
        "intersecting-display-tiles; intersecting-source-objects; clipped-labels-and-search; padded-whole-routing-cells",
      routingPaddingCells: s.paddingCells,
    },
  };
  async function stage(name: string, build: (path: string) => Promise<void>) {
    signal.throwIfAborted();
    await space();
    const path = join(o.work, name),
      receipt = state.completed[name];
    const verify = () => {
      const report = measuredProgress(
        progress,
        `verify-${name}`,
        `Verifying ${name}`,
        Bun.file(path).size,
        "bytes",
      );
      return fileHash(path, (done) => report(done), signal);
    };
    if (receipt) {
      const file = Bun.file(path);
      if (file.size !== receipt.size || (await verify()) !== receipt.sha256)
        throw new Error(`Completed stage ${name} changed on disk`);
      progress(`Reusing ${name}`);
      return path;
    }
    progress(`Building ${name}`);
    await build(path);
    signal.throwIfAborted();
    state.completed[name] = {
      size: Bun.file(path).size,
      sha256: await verify(),
    };
    const temporary = statePath + ".part";
    await Bun.write(temporary, JSON.stringify(state));
    await import("node:fs/promises").then((fs) =>
      fs.rename(temporary, statePath),
    );
    progress(`Saved ${name}`);
    return path;
  }
  async function archive(
    path: string,
    build: (w: StreamWriter) => Promise<Omit<Manifest, "snapshot">>,
  ) {
    const w = await new StreamWriter(path, s.maxBytes).open();
    try {
      const manifest = await build(w);
      const label = path.split("/").at(-1)!;
      let current = "",
        report: (done: number) => void;
      await w.finish(manifest, space, (step, done, total) => {
        if (current !== step) {
          current = step;
          report = measuredProgress(
            progress,
            `archive-${step}-${label}`,
            `${step === "directory" ? "Writing directory for" : "Finalizing payload for"} ${label}`,
            total,
            step === "directory" ? "blocks" : "bytes",
          );
        }
        report(done);
      });
    } catch (e) {
      await w.abort();
      throw e;
    }
  }
  const artifacts: string[] = [];
  try {
    // Spool one transport profile at a time before retaining the semantic source store.
    if (s.profiles.length)
      artifacts.push(
        await stage("transport.atlas", (path) =>
          archive(path, async (w) => {
            const counts = Object.fromEntries(
              s.profiles.map((mode) => [
                mode,
                { count: 0, nodes: 0, segments: 0, turns: 0 },
              ]),
            ) as Record<
              TransportMode,
              { count: number; nodes: number; segments: number; turns: number }
            >;
            const filtered: BlockWriter = {
              add: async (b) => {
                const parts = b.key.split("/"),
                  mode = parts[1] as TransportMode;
                if (
                  !selectedCell(
                    s.polygon,
                    14,
                    Number(parts[4]),
                    Number(parts[5]),
                    s.paddingCells,
                  )
                )
                  return;
                const v = new DataView(
                    b.bytes.buffer,
                    b.bytes.byteOffset,
                    b.bytes.byteLength,
                  ),
                  c = counts[mode];
                c.count++;
                c.nodes += v.getUint32(20, true);
                c.segments += v.getUint32(24, true);
                c.turns += v.getUint32(28, true);
                await w.add(b);
              },
            };
            const transport = await addPartitionedTransport(
              filtered,
              o.input,
              o.work,
              s.profiles,
              signal,
              progress,
              inputHash,
            );
            for (const mode of s.profiles)
              Object.assign(transport.profiles[mode]!, counts[mode]);
            transport.graphSnapshot = inputHash;
            return { ...base, transport, capabilities: ["transport-routing"] };
          }),
        ),
      );
    if (state.completed["transport.atlas"]) {
      for (const name of [
        "routing-v2.sqlite",
        "routing-v2.sqlite-wal",
        "routing-v2.sqlite-shm",
        "routing-needed.bits",
        "routing-coordinates.bin",
      ])
        await rm(join(o.work, name), { force: true });
    }

    const needsSem =
      s.featureKinds.length ||
      s.search ||
      s.reverse ||
      s.placeNames ||
      s.streetNames ||
      s.pois ||
      s.peaks;
    const needsSource =
      (needsSem && !state.completed["semantics.atlas"]) ||
      (s.layers.length && !state.completed["display.atlas"]);
    let source: Database | undefined;
    if (needsSource) {
      const path = await stage("source.sqlite", async (path) => {
        await runCompiler(
          [join(ROOT, "target/release/source-store"), o.input, path],
          ROOT,
          signal,
          progress,
          { ...process.env, TMPDIR: o.work, ATLAS_SOURCE_HASH: inputHash },
        );
      });
      source = new Database(path, { readonly: true });
      source.run(
        "PRAGMA cache_size=-32768; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;",
      );
      const stats = JSON.parse(
        source
          .query<
            { json: string },
            []
          >("SELECT json FROM metadata WHERE key='stats'")
          .get()!.json,
      );
      base.areas = {
        assembledRelations: stats.assembledRelations,
        skippedRelations: stats.skippedRelations,
      };
      base.limitations.push(
        `${stats.assembledRelations} area relations assembled; ${stats.skippedRelations} incomplete or unsupported area relations skipped; ${stats.skippedWays} ways with missing nodes skipped.`,
      );
    }
    try {
      if (needsSem)
        artifacts.push(
          await stage("semantics.atlas", (path) =>
            archive(path, async (writer) => {
              const searchPath = join(o.work, "search.sqlite"),
                groupsPath = join(o.work, "groups.sqlite"),
                spoolPath = join(o.work, "objects.sqlite");
              for (const file of [
                searchPath,
                searchPath + "-journal",
                groupsPath,
                spoolPath,
              ])
                await rm(file, { force: true });
              const search = new PagedSearchBuilder(searchPath),
                spool = new BlockSpool(spoolPath, identity);
              const region: GeoPolygon = {
                type: "Polygon",
                coordinates: [[...s.polygon, s.polygon[0]!]],
              };
              const labels = (locations: any[], streets: any[]) => {
                if (!s.streetNames && !s.pois) return;
                for (const [key, data] of partitionLabels(
                  buildLabels(
                    {
                      schema: "locations-v1",
                      records: s.pois ? locations : [],
                    },
                    {
                      schema: "streets-v1",
                      streets: s.streetNames ? streets : [],
                    },
                  ),
                ))
                  spool.json(key, data);
              };
              const semantic = new SourceGeocoding(
                source!,
                {
                  addLocation: (r) => {
                    if (inside(r.coordinates, s.polygon)) {
                      if (s.search) search.addLocation(r);
                      labels([r], []);
                    }
                  },
                  addStreet: (r) => {
                    for (const coordinates of clipLine(
                      r.coordinates,
                      s.polygon,
                    )) {
                      const part = { ...r, coordinates };
                      if (s.reverse) search.addStreet(part);
                      labels([], [part]);
                    }
                  },
                },
                groupsPath,
              );
              const overview: Place[] = [];
              let peaks = 0,
                known = 0,
                highest: Peak | null = null,
                featureCount = 0;
              try {
                spool.begin();
                if (s.search || s.pois) {
                  const total = source!
                    .query<
                      { n: number },
                      []
                    >("SELECT count(*) AS n FROM locations")
                    .get()!.n;
                  const report = measuredProgress(
                    progress,
                    "semantic-nodes",
                    "Adding named locations and POIs",
                    total,
                    "records",
                  );
                  await semantic.addNodes(signal, report);
                }
                if (s.placeNames)
                  for (const { json } of source!
                    .query<
                      { json: string },
                      []
                    >("SELECT json FROM locations WHERE kind='place' AND category IN ('city','town','village') ORDER BY id")
                    .iterate()) {
                    const p = JSON.parse(json);
                    if (!inside(p.coordinates, s.polygon)) continue;
                    const place: Place = {
                        name: p.name,
                        coordinates: p.coordinates,
                      },
                      [x, y] = project(...(p.coordinates as [number, number]));
                    spool.json(
                      `labels/settlements/8/${Math.min(255, Math.floor(x * 256))}/${Math.min(255, Math.floor(y * 256))}`,
                      { schema: "places-v1", places: [place] },
                    );
                    if (p.category === "city") overview.push(place);
                    if (overview.length > 100000)
                      throw new Error("City overview exceeds its label budget");
                  }
                if (s.peaks)
                  for (const { json } of source!
                    .query<
                      { json: string },
                      []
                    >("SELECT json FROM peaks ORDER BY id")
                    .iterate()) {
                    const p: Peak = JSON.parse(json);
                    if (!inside(p.coordinates, s.polygon)) continue;
                    peaks++;
                    if (p.elevation !== null) {
                      known++;
                      if (!highest || p.elevation > highest.elevation!)
                        highest = p;
                    }
                    const [x, y] = project(...p.coordinates);
                    spool.json(
                      `query/peaks-data/8/${Math.min(255, Math.floor(x * 256))}/${Math.min(255, Math.floor(y * 256))}`,
                      [p],
                    );
                  }
                let count = 0;
                const featureTotal = source!
                  .query<
                    { n: number },
                    []
                  >("SELECT count(*) AS n FROM features")
                  .get()!.n;
                const featureProgress = measuredProgress(
                  progress,
                  "semantic-features",
                  "Building search, labels and selectable features",
                  featureTotal,
                );
                for (const { data } of source!
                  .query<
                    { data: Uint8Array },
                    []
                  >("SELECT data FROM features ORDER BY rowid")
                  .iterate()) {
                  signal.throwIfAborted();
                  const bytes = Bun.gunzipSync(data as Uint8Array<ArrayBuffer>);
                  if (bytes.length > 64 * 1024 * 1024)
                    throw new Error(
                      "Source object exceeds semantic working-set budget",
                    );
                  const feature: Feature = JSON.parse(
                      new TextDecoder().decode(bytes),
                    ),
                    fc = {
                      type: "FeatureCollection" as const,
                      features: [feature],
                    };
                  if (s.search || s.reverse || s.streetNames || s.pois)
                    semantic.addFeatures(fc);
                  if (
                    s.featureKinds.length &&
                    booleanIntersects(feature, region)
                  )
                    for (const [key, features] of buildFeatures(fc))
                      if (s.featureKinds.includes(key.split("/")[1] as any)) {
                        spool.json(key, { schema: "features-v1", features });
                        featureCount++;
                      }
                  if (++count % 5000 === 0) {
                    featureProgress(count);
                    spool.checkpoint(count);
                    spool.begin();
                    await space();
                    await new Promise((r) => setTimeout(r, 0));
                  }
                }
                featureProgress(count);
                const groupsProgress = measuredProgress(
                  progress,
                  "semantic-streets",
                  "Finalizing named street groups",
                  semantic.groupCount,
                  "records",
                );
                await semantic.finish(signal, groupsProgress);
                spool.checkpoint(count);
                if (s.search || s.reverse)
                  await search.finish(
                    writer,
                    { search: s.search, reverse: s.reverse, workers },
                    signal,
                    progress,
                  );
                const packing = measuredProgress(
                  progress,
                  "semantic-packing",
                  "Packing labels and selectable features",
                  spool.blockCount,
                  "blocks",
                );
                await spool.write(writer, signal, (_key, done) =>
                  packing(done),
                );
                if (s.placeNames)
                  await writer.add({
                    key: "labels/places",
                    bytes: encode({
                      schema: "places-paged-v1",
                      zoom: 8,
                      overview,
                    }),
                  });
                if (s.peaks)
                  await writer.add({
                    key: "query/peaks",
                    bytes: encode({
                      schema: "peaks-paged-v1",
                      peak: highest,
                      known,
                      unknown: peaks - known,
                    }),
                    features: peaks,
                  });
                return {
                  ...base,
                  peaks,
                  places: [],
                  labelZoom:
                    s.placeNames || s.streetNames || s.pois
                      ? LABEL_ZOOM
                      : undefined,
                  featureZoom: s.featureKinds.length ? FEATURE_ZOOM : undefined,
                  featureKinds: s.featureKinds,
                  capabilities: [
                    ...(s.search ? ["location-search"] : []),
                    ...(s.reverse ? ["reverse-street"] : []),
                    ...(s.placeNames || s.streetNames || s.pois
                      ? ["map-labels"]
                      : []),
                    ...(s.peaks ? ["peak-query"] : []),
                    ...(s.featureKinds.length ? ["feature-extraction"] : []),
                  ],
                };
              } finally {
                semantic.close();
                spool.close();
                await search.dispose();
                for (const p of [groupsPath, spoolPath])
                  await rm(p, { force: true });
              }
            }),
          ),
        );
      if (s.layers.length)
        artifacts.push(
          await stage("display.atlas", (path) =>
            archive(path, async (writer) => {
              const spoolPath = join(o.work, "display-fragments.sqlite"),
                spool = new BlockSpool(spoolPath, identity);
              try {
                await partitionTiles(
                  source!,
                  spool,
                  s,
                  signal,
                  progress,
                  workers,
                );
                const packing = measuredProgress(
                  progress,
                  "display-packing",
                  "Packing display tiles",
                  spool.blockCount,
                  "blocks",
                );
                await spool.write(writer, signal, (_key, done) =>
                  packing(done),
                );
                const heights = {
                  tagged: 0,
                  estimated: 0,
                  missing: 0,
                  maxMeters: 0,
                };
                if (s.layers.includes("buildings")) {
                  const heightsProgress = measuredProgress(
                    progress,
                    "building-heights",
                    "Collecting building height statistics",
                    source!
                      .query<
                        { n: number },
                        []
                      >("SELECT count(*) AS n FROM features WHERE class=2")
                      .get()!.n,
                  );
                  let heightCount = 0;
                  for (const { data } of source!
                    .query<
                      { data: Uint8Array },
                      []
                    >("SELECT data FROM features WHERE class=2")
                    .iterate()) {
                    const f = JSON.parse(
                        new TextDecoder().decode(
                          Bun.gunzipSync(data as Uint8Array<ArrayBuffer>),
                        ),
                      ),
                      h = buildingHeight(f.properties.tags);
                    heights[
                      (h.source & 3) === 1
                        ? "tagged"
                        : (h.source & 3) === 2
                          ? "estimated"
                          : "missing"
                    ]++;
                    heights.maxMeters = Math.max(
                      heights.maxMeters,
                      h.height,
                      h.minHeight,
                    );
                    if (++heightCount % 10000 === 0) {
                      heightsProgress(heightCount);
                      await new Promise((r) => setTimeout(r, 0));
                    }
                  }
                  heightsProgress(heightCount);
                }
                return {
                  ...base,
                  tileLayers: s.layers,
                  buildingHeights: s.layers.includes("buildings")
                    ? heights
                    : undefined,
                  capabilities: [
                    "vector-rendering",
                    ...(s.layers.includes("buildings")
                      ? ["building-heights"]
                      : []),
                  ],
                };
              } finally {
                spool.close();
              }
            }),
          ),
        );
    } finally {
      source?.close();
    }
    // Derived stage archives now contain everything needed; release source/fragment spools before assembly.
    for (const name of ["source.sqlite", "display-fragments.sqlite"]) {
      await rm(join(o.work, name), { force: true });
      delete state.completed[name];
    }
    await Bun.write(statePath + ".part", JSON.stringify(state));
    await import("node:fs/promises").then((fs) =>
      fs.rename(statePath + ".part", statePath),
    );
    // Stream every directory leaf and payload. Never collect all block descriptors.
    await archive(o.output, async (writer) => {
      let manifest = { ...base },
        caps = new Set<string>();
      const totalBytes = artifacts.reduce(
        (sum, path) => sum + state.completed[path.split("/").at(-1)!]!.size,
        0,
      );
      let copied = 0;
      const packing = measuredProgress(
        progress,
        "assembly",
        "Assembling final Atlas package (input bytes)",
        totalBytes,
        "bytes",
      );
      for (const path of artifacts) {
        let payloadCopied = 0;
        const reader = await new AtlasReader(
          new FileSource(Bun.file(path)),
        ).open();
        try {
          const { snapshot, ...m } = reader.index.manifest;
          manifest = { ...manifest, ...m, capabilities: [] };
          for (const c of m.capabilities) caps.add(c);
          // Optional fields from earlier artifacts survive Object.assign (absent fields are omitted in JSON).
          for await (const block of reader.iterateBlocks()) {
            signal.throwIfAborted();
            await writer.add({
              ...block,
              codec: undefined,
              rawLength: undefined,
              bytes: await reader.block(block.key),
            });
            copied += block.length;
            payloadCopied += block.length;
            packing(copied);
            reader.cache.delete(block.key);
          }
        } finally {
          reader.dispose();
        }
        copied += Bun.file(path).size - payloadCopied;
        packing(copied);
      }
      // Base counters in later stage manifests must not overwrite semantic counts.
      for (const path of artifacts) {
        const r = await new AtlasReader(new FileSource(Bun.file(path))).open();
        const m = r.index.manifest;
        if (m.capabilities.includes("peak-query")) manifest.peaks = m.peaks;
        r.dispose();
      }
      manifest.capabilities = [...caps];
      manifest.features = writer.featureCount("tile/");
      manifest.featureCountKind = "tile-records";
      return manifest;
    });
    progress(`Partitioned build complete: ${o.output}`);
    return o.output;
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearInterval(timer);
  }
}
