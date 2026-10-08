# Planet sizing: planning envelope, October 2026

**Budget 1–2 TB per complete planet snapshot**, excluding imagery and terrain rasters. A deliberately sparse overview map is much smaller. A complete historical OSM archive is a different product. These are engineering estimates for a redesigned, partitioned Atlas stack, not measured results from the current compiler.

All estimates below use decimal GB/TB. Exact output depends on retained tags/addresses/languages, geometry tolerance, duplicated zooms, routing modes, index layout, coverage and update policy. The largest uncertainty is full geocoding/search and source-object retention, not color/style choice. A `.atlas` file is a container: one file does not imply one compression stream or one object loaded into RAM.

## Evidence anchors

- The [OSM planet PBF listing](https://planet.openstreetmap.org/pbf/) lists the 2026-09-28 planet (published October 1) at about 89 GiB, roughly **95 GB**. This is current OSM data, not full history.
- [Protomaps basemap documentation](https://docs.protomaps.com/basemaps/downloads) gives about **120 GB for z0–15** and notes that adding a zoom level roughly doubles its archive size. That makes a few hundred GB a useful display-only z0–16 anchor, not a guarantee for our classes/codec.
- [Planetiler's own benchmarks](https://github.com/onthegomap/planetiler#benchmarks) report an **81 GB PMTiles** output from a March 2026 92 GB planet input using its OpenMapTiles profile. That different schema/detail policy illustrates why input size alone cannot determine output size.
- A [Valhalla maintainer's 2022 estimate](https://github.com/valhalla/valhalla/discussions/3661) puts routing graphs without historical traffic around **1–1.5× OSM PBF size**. It is an old planning anchor, not a current Atlas or Valhalla measurement.
- [Nominatim's current installation guidance](https://nominatim.org/release-docs/latest/admin/Installation/) recommends **128 GB+ RAM for full-planet import and at least 1 TB disk**, with fast NVMe. That is a full database-backed address/geocoding installation; a compact immutable Atlas index is not proven to achieve equivalent capability at a lower size.

Our measured Vienna Plus package is **619.6 MB** from the **186.2 MB merged regional PBF** (not from the 1.48 GB downloaded country inputs). It contains **238.9 MB display geometry**, about **241.6 MB added source-geometry capability**, a **69.45 MB walking graph**, and labels/search/street/catalog data. Multiplying its total 3.33× expansion ratio by a 95 GB planet gives roughly 316 GB. **Do not use that as the capacity plan:** Vienna's composition is not globally representative, its geocoder is only a regional name/nearest-street demo, and global addresses/admin indexes/graph acceleration are absent.

## Estimated stored payloads

Assume current OSM only; vectors through z16 including buildings; reusable geometry/typed columns; deduplicated source objects; walking/cycling/driving graph topology with profile costs and acceleration; named POIs, addresses and administrative hierarchy; no live traffic, transit timetables, imagery, terrain rasters or history.

| Component                                                      | Planning estimate | Main sensitivity                                                    |
| -------------------------------------------------------------- | ----------------: | ------------------------------------------------------------------- |
| Display vectors and labels, z0–16                              |        200–500 GB | Max zoom, geometry tolerance, class separation, label languages     |
| Routing topology, costs, snapping and acceleration             |        100–200 GB | Access/turn restrictions, hierarchy, profile representation         |
| Search, addresses and forward/reverse indexes                  |        100–300 GB | Address hierarchy, aliases, tokenization, languages and ranking     |
| Optional full source shapes/tags for object queries/extraction |        200–600 GB | Attribute retention, object deduplication and spatial posting lists |
| Catalogs, hashes and remaining index overhead                  |          20–80 GB | Page fanout, block size, directory encoding                         |
| **All above**                                                  |  **620–1,680 GB** | **Round to 1–2 TB per snapshot for planning**                       |

Without full source-object extraction, approximately **420–1,080 GB** is a more relevant envelope. A map-only planet may be **200–500 GB plus catalog overhead**. The query layer is optional: viewing it never means downloading the entire file. These component ranges are ours, not vendor promises, and should be replaced with measured regional benchmark samples before provisioning a production system.

A complete Nominatim-equivalent implementation may require more than the 100–300 GB compact-index hypothesis. If using Nominatim as a sidecar now, allocate its documented 1 TB+ separately instead of assuming it fits inside that row. Raster basemaps, DEMs, satellite imagery, high-detail 3D meshes and history can add TBs and should have explicit independent budgets. OSM alone does not provide those datasets.

## Machines to plan around

These are starting configurations for prototyping, not throughput guarantees. Hosting and generation are separate workloads; no GPU is required for range serving, search or routing. The client's GPU draws the map.

| Workload                                    | Candidate configuration                                                         | Meaning                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static `.atlas` byte delivery               | Object storage + CDN, or 2–4 vCPU / 4–8 GB RAM / enough local SSD for snapshots | HTTP ranges, bounded cache; bandwidth and cache efficiency dominate. No server-side search/routing in this row.                                                   |
| All operations on one modest-traffic server | **16 modern CPU cores, 128 GB RAM, 4–8 TB usable NVMe**                         | For example, 2×4 TB mirrored gives 4 TB usable, or 2×8 TB gives 8 TB. Use the larger option for two snapshots near 2 TB each plus headroom; a backup is separate. |
| Full rebuild machine                        | **32–64 cores, 256 GB RAM, 8–16 TB usable fast scratch storage**                | Inputs, sort/spool stages, graph/search builds, validation, old + new outputs. Temporary capacity can exceed final archive size severalfold.                      |
| Sustained public service                    | Replicated compute workers + shared immutable snapshots/CDN                     | Size from route distances, requests/second, cache misses and latency targets. Avoid blocking all users behind one route or export.                                |

For the combined server, assume an initial low-to-moderate workload around **1–5 mixed semantic requests/second**, mostly ordinary local/regional routes; this is a benchmark target, not proven capacity. Global long-distance routing, matrices, isochrones and bulk extraction can be much heavier. Measure p50/p95 latency and concurrency with cold and warm caches before accepting a traffic target. A 1 Gbit/s link has a theoretical ceiling of 125 MB/s: at 5 MB of uncached map data per new visit, about 25 such visits/second before overhead or any other traffic. CDN caching matters more than adding CPU to the byte server.

The 128 GB machine need not hold a TB archive in RAM. It caches popular pages; cold pages remain on NVMe. The exact split between graph/search working sets, OS cache and request workers must come from benchmarks. There is no defensible monthly hosting price without a provider, region, bandwidth and availability target.

## What must change before planet

The current repo cannot be made planet-ready just by choosing a larger server:

1. **Disk-backed serving.** `apps/server/index.ts` copies the entire file into a Blob at startup and hashes it. Replace this with an open immutable snapshot file/object, positional range reads, precomputed identity and atomic snapshot switching. Keep current and previous versions available for in-flight clients.
2. **Hierarchical catalogs and bounded caches.** Display directories are paged, but all page descriptors/label entries still sit in the root, and decoded caches grow without eviction. Introduce multi-level directories, binary metadata, explicit RAM budgets and optional persistent verified block caching.
3. **Partitioned routing with a hierarchy.** The existing one-block walking graph uses linear snapping and Dijkstra, and enforces an 8 million node / 12 million segment decoder ceiling. Add spatial snapping, graph partitions and boundary identities, higher-level shortcuts/MLD or CH, turn restrictions, profile semantics and resumable missing-block search. Merely placing the existing graph in tiles does not make continental routes efficient.
4. **Indexed geocoding.** Replace in-memory scans with paged token/FST or inverted indexes, address/admin context, spatial indexes and explicit coverage. Store search and reverse indexes independently; route geometry and visible tiles cannot supply complete address semantics.
5. **External-memory generation.** The native importer and geojson-vt stage retain regional objects in memory. Stream PBF into sorted node/way/relation/column stores, partition builds, process multipolygons explicitly and bound spool/merge memory. Avoid copying full source objects into every intersecting spatial cell; use object records plus posting lists.
6. **Shared operations, independent workers.** Keep the client/server algorithm contract, but provide native Rust workers for large server workloads and WASM for bounded client workloads. The current API serializes operations; it is not a concurrency architecture for public planet service. Add cancellation, quotas and range coalescing based on actual workloads.
7. **Incremental publication.** Content-address chunks and publish a new root/manifest, then compact when worthwhile. Rewriting and distributing a TB after every small update would defeat the design. A logical single archive can be exported as one physical file for offline use while immutable chunks are discovered through Nostr/Hashtree. That transport is future work.

Before a planet build, benchmark at least an urban region, sparse rural region, mountain region, coastline-heavy region and a multilingual/address-rich country. Record bytes per capability, index overhead, peak builder RSS, cold/warm query latency and requested graph pages for progressively longer routes. A Europe build is a useful next scaling checkpoint; it will expose weaknesses that one city cannot.
