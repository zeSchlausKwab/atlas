# Europe demo preparation

Target agreed on 2026-10-10: full Europe at z0–16, all supported geometry, labels,
walking/cycling/driving routing and isochrones, location search, nearest street,
peak queries and extractable source features. The user chose full detail rather
than a reduced overview, and authorized predownloading the planet PBF.

## Current workflow: partitioned compiler

1. Open <http://192.168.0.179:3100/host>. Trusted LAN administration is configured;
   the public map client remains a separate application.
2. Keep a verified planet or Europe PBF in the Source library. The cached planet
   is `planet-261005.osm.pbf`, 95,244,184,503 bytes (88.70 GiB), SHA-256
   `1f0255832803e73280b634f0cd5767d287a9b63c15220388c7862efca393f9ef`.
3. **Configure full Europe · z0–16** restores the saved all-capability recipe.
   **Build Europe & host** saves it and starts an actual preparation job using
   the cached Europe source, or the cached planet if Europe is absent.
4. Watch extraction, transport, semantic indexes, display batches and final
   packing in Preparation progress. Closing the page does not stop the job.
   A stopped/restarted job can resume its verified stages. Deployment refuses
   to replace the server while a preparation is active.
5. Only a completed archive enters the public catalog. Open its library card
   in the standalone client, or add it through Client composer.

When using the planet, the Europe preset extracts the provider's bounding
rectangle, including adjacent regions. It is **not a political Europe boundary**.
The saved 128 GiB output cap is a budget, not a prediction. The admission check
requires output budget + 64 GiB workspace + 60 GiB reserve. This is a minimum
allowance, not a continental disk-use estimate; actual space is checked during
work and the job stops if it approaches the reserve. A cached PBF alone is not
a rendered map.

## Construction and recovery

Large cached-source requests now use `partitioned-cached.ts` and
`packages/cli/src/partitioned.ts`. Smaller requests retain the regional path.
The new path does not retain a whole graph, all source geometry, or a complete
search index in memory:

- Smart-extract the area from the verified PBF and check references. A checksum
  checkpoint avoids repeating the planet scan after this stage completes.
- Store sorted node coordinates in a temporary, file-backed 17-byte/node index.
  Preserve original OSM node identities and decimicrodegree precision.
- Spool directed segments and restrictions to SQLite, one transport mode at a
  time. Emit one z14 RCL2 cell at a time with canonical source segment ordinals.
  This retains cross-cell connectivity and the existing WASM routing contract.
- Build a SQLite source object store; assemble one multipolygon relation at a
  time. Settlement proximity and street grouping also use disk indexes.
- Write paged text postings, location records, nearest-street cells, labels,
  peak summaries and extractable geometry. Clients and server operations read
  the same independently verified pages.
- Tile spatially ordered geometry in bounded batches. SQLite atomically commits
  each batch's fragments and source cursor; an interrupted batch rolls back.
- Write compressed payloads and directory descriptors incrementally. Final
  packing compacts the reserved header space in place, avoiding a second
  complete archive copy. Publication is an atomic rename.

Completed stage files have SHA-256 receipts tied to source, recipe and compiler
version. Invalid receipts fail explicitly. Unfinished native import, graph and
semantic stages restart; completed stages are reused. Display generation resumes
at its last committed batch. Finished source/fragment scratch is removed before
final assembly. Source downloads remain independent systemd units; preparations
are children of the Atlas service and become resumable when that service stops.

This removes the known whole-region graph/search memory bottlenecks. **Continental
completion and peak disk/RAM use still require the first Europe run.** The service
retains its 20 GiB memory limit. Oversized individual relations, cells, blocks or
directories fail explicitly; capabilities are never silently dropped. See
[compiler contracts and limits](PARTITIONED-COMPILER.md).

## Verification

The all-capability Liechtenstein z0–16 fixture produced 5,339 display blocks and
242 routing cells. Every display record and every routing-cell byte matches the
regional pipeline (display ordering is compared as a multiset). Native source
parity covers 37,146 features, 3,111 grouped locations and 7,696 street records.
Search results and totals, reverse geocoding, peak summaries and paged labels
also agree. These are compatibility checks, not a Europe-scale benchmark.

```sh
bun run verify:partitioned-graph data/liechtenstein.osm.pbf
bun run verify:source-store data/liechtenstein.osm.pbf
bun run cli generate --partitioned --input data/liechtenstein.osm.pbf \
  --output /tmp/new.atlas --selection /tmp/selection.json
bun run verify:partitioned-build /tmp/new.atlas /tmp/regional.atlas /tmp/selection.json
```

The last command expects two all-capability Liechtenstein builds of the same
source/zooms and a matching selection recipe. It selects the regional reference
before comparing it. Unit tests cover interrupted display batches, rollback,
search-page budgets, writer compaction and preservation of an existing archive
when replacement fails. `verify:cached-build` retains the regional lifecycle and
cross-partition routing check.

The following sections are historical deployment records; descriptions of
compiler limitations and download progress apply to their stated revision.

## Live verification — 2026-10-10

Deployed host revision `aba19df` to `192.168.0.179:3100`. The trusted LAN host
console loads the four prepared maps, storage, and eight published operations.
The live provider catalog includes empty coverage placeholders for some regions;
these are skipped so valid Europe and regional coverage can still be selected.

Saved `Europe · all capabilities` through the LAN UI and verified it reloads:
z0–16, six display layers, all labels, three transport modes, search, nearest
street, peaks, and all five extraction categories. The saved output budget is
128 GiB, not a size estimate. The recipe is on the server at
`/home/nixuser/atlas/shared/data/sources/europe-recipe.json`.

Planet download job `59ec685fcfa1e7dfc515c1e7c4854c49` started successfully and
continued while Atlas was deployed/restarted. Pause through the UI retained
9,416,265,728 bytes; Resume appended to those bytes and passed 9.6 GB. It was
still downloading when verified, not yet checksum-complete. Progress and
Pause/Resume are in the Source library. The independent user service is
`atlas-source-59ec685fcfa1e7dfc515c1e7c4854c49.service`.

Verification: TypeScript check, 13 focused source/admin/import tests (108
assertions), host build, and deployment smoke checks passed. The full Bun suite
had passed before the initial source-library deployment. Real browser checks
covered LAN access, all-capability recipe save/reload, and planet pause/resume.
The existing `lemond.service` remained active. No full-Europe map was compiled.

## Download memory fix — 2026-10-10

The first planet transfer later stopped at roughly 26.9 GiB. The worker journal
and kernel log at 13:48 CEST reported `oom-kill`: application memory reached its
1 GiB cgroup limit. The server still had 349 GiB free disk space. The console had
mistakenly presented any vanished worker as an ordinary paused download.

The downloader had requested the entire remaining PBF in one HTTP response.
A slow consumer can cause this Bun runtime to buffer far ahead of disk writes
(also reported upstream at <https://github.com/oven-sh/bun/issues/32471>).
Transfers now request sequential 16 MiB ranges and validate the exact returned
range, total size, and pinned ETag before appending. The worker also uses Bun's
low-memory mode; the existing 1 GiB safety limit is unchanged. Transient network
failures retry from the partial file with bounded backoff; changed identity,
checksum failures and disk errors still require attention. Pause cancels retry
waits. Failed systemd units retain their result for diagnostics, and unexpected
exits display as failures, including the memory-limit reason when available.

Reproduction: a local 1.5 GiB fixture and a delayed consumer with a 256 MiB
systemd limit killed the old implementation in 255 ms. Sequential ranges
completed and verified the same fixture in 9.7 seconds. Run the reusable check
on the Linux server with `bun run verify:source-memory`. Fixture files and the
transient test unit are cleaned up; it does not read or change the planet cache.

Deployed fix `b758a4e`, then replaced the existing worker at 14:13 CEST while
preserving 30,665,495,147 downloaded bytes. The fixed worker continued past
31.1 GB with about 24 MiB anonymous memory at inspection and zero cgroup OOM
or memory-limit events. The deployed memory regression also passed in 10.2 s.
The host UI showed downloading, and the existing model service remained active.
The planet transfer was still in progress; final checksum verification remains
part of the completion path.

## Cached-planet compiler pilot — 2026-10-10

Deployed revision `351007f` and built **Vienna–Bratislava · planet build** directly
from the verified local `planet-261005.osm.pbf`. No additional regional source
was downloaded. Source SHA-256:
`1f0255832803e73280b634f0cd5767d287a9b63c15220388c7862efca393f9ef`.

- Published map ID: `047b3a1b-12ca-4097-b5cd-83d065628acc`.
- Final size: **310,866,782 bytes (296.47 MiB)**; z0–16, all six display layers,
  all labels, three transport profiles, search, nearest street, peaks and all
  five extraction categories.
- Six z9 display partitions, 15 checkpoint stages; one canonical regional graph.
- Regional PBF: **117,785,370 bytes (112.33 MiB)**, extracted in roughly
  16 minutes through three sequential passes of the 88.70 GiB planet.
- Deliberately stopped after the extraction checkpoint, deployed/restarted the
  host, then resumed the same job. It verified and reused that PBF without
  repeating the planet scan. Published at approximately 14:57 UTC, about
  23 minutes after the job started, including the deliberate stop/deployment.
- Linux service memory peak: **5,923,127,296 bytes (5.52 GiB)** after the restart,
  covering compilation and publication; the earlier extraction peaked around
  4.57 GiB. These are cgroup measurements, not a prediction for Europe.
- Server retained roughly **286 GiB free** after publication and scratch cleanup.
  The independent model service stayed active.

Host console: <http://192.168.0.179:3100/host>. Open the map from its library card
in the independent client. The initial fitted browser view read about 670 KB;
starting a route then fetched routing cells on demand.

Validation includes 138 Bun tests, the Rust workspace tests, TypeScript checks,
host/client builds and deployment smoke checks. The small real-PBF integration
fixture tests interrupted/resumed compilation and all three routes across a seam;
41 partitioned display tiles match the single-region reference byte-for-byte,
including water and a courtyard building.

Run the real-data acceptance check with:

```sh
bun run verify:hosted-region \
  http://192.168.0.179:3100/maps/047b3a1b-12ca-4097-b5cd-83d065628acc.atlas \
  data/cached-planet-verification.json
```

It samples geometry at z0, 5 and 11–16 in both cities and on either side of the
16.875° partition seam. Search, nearest street, highest peak, local building /
water / railway extraction, and 1-/3-minute isochrones agree between device and
server. Fischamend–Hainburg crosses that seam in all three modes: driving
37.40 km, cycling 28.64 km, walking 26.96 km, with identical client/server route
coordinates and costs.

### Limits observed on real data

The longer Vienna–Bratislava walk completes with the client's **1 million
states** option: 62.68 km, 379,341 explored nodes and 256 cells. The browser
rendered that route and remained interactive; the final run reported roughly
795 ms in WASM and 4.9 s overall, including cache reads / newly fetched cells.
The default 250,000-state limit is insufficient for this walk and the long
cycling route. Server tools still use that default budget.

The long driving search reaches the package's northern routing boundary before
it can prove a route. The larger-budget cycling search also encounters missing
coverage. These are explicit `missing-data` results, not `no-route`, and no
outside cells are silently treated as empty. A wider routing buffer or adjacent
compatible coverage is needed for those searches. The acceptance report records
these limits separately from the successful shorter cross-seam routes.

A city-wide source-feature query also exceeded the intentional 64 MiB scan
budget. The extraction parity checks use a smaller Danube Canal viewport.
`limit: 10` limits returned features, not scan work, because the current query
also computes the complete match count. Bounded pagination / early exit is
another follow-up for larger datasets.

This is a **regional compiler milestone**, not a full-Europe build. Before
running the saved Europe recipe, partition graph/semantic construction and
search indexing, bound final directory memory, and make routing coverage / work
budgets explicit in build and operation interfaces. Do not remove the regional
admission guards merely because the source PBF fits on disk.

## Partitioned compiler deployment and first Europe run — 2026-10-10

Compiler implementation commits: `fdb085b` and `8780ef9`. Deployed revision
`3c0cca4` (including corrected host copy) as release
`20261010T172931718Z-3c0cca454c9d-04440439`. Both host and the local standalone
client understand the new semantic pages. The existing map library remains
available and the independent model service remains active.

Validation passed: 143 Bun tests, Rust workspace tests, TypeScript, both browser
builds, source parity and full-package parity. In the real browser, Vaduz search
returned 148 matches with 0.15 MB read, and the new package routed Vaduz–Triesen
in driving mode (3.76 km, seven cells, 0.22 MB read). Direct HTTP comparisons
matched client/server route coordinates and costs for walking, cycling and
driving, reachable-area contours for 60/180-second bands, search, nearest street
and highest peak.

Started **Europe · all capabilities** from the host UI at 17:31:48 UTC:
job `f338f58d-7554-41c8-8424-56d841fb3d25`. The persisted recipe contains z0–16,
six display layers, all labels, three profiles, search, reverse geocoding,
peaks, all five extraction categories, one routing padding cell and a 128 GiB
output budget. It uses the verified 88.70 GiB planet cache. Roughly 285 GiB was
free at launch. The progress card and `osmium` process confirmed extraction was
running (6% at observation); this percentage is extraction progress, not total
build completion. Continental compilation, final size and peak resource use
remain unverified until the job completes.

## Coordinate lookup recovery — 2026-10-11

The first Europe attempt was stopped at the user's request. At approximately
05:38 UTC it had reached 15.5 million eligible walking ways / 154 million
segments after roughly twelve hours. The 39.605 GiB area extraction completed;
no whole graph profile had completed. Its private 63.684 GiB coordinate mapping
was causing random page faults under the service's 16 GiB memory-high limit:
about 4.8 TB physical reads and 36.6 million major faults, with about 69 KiB/s
PBF cursor advance in a 162-second sample. Disk space was not exhausted.

The replacement uses page-aligned indexed coordinate lookup for every importer,
routing-only coordinate retention and durable graph blob/cell checkpoints.
The original extraction receipt and source are retained. The old graph spool
has no trustworthy restart cursor and cannot be reused. The original Europe
job ID and recipe are retained so restarting reuses the verified extraction.
Reference parity and forced-stop tests pass; continent-scale throughput and
completion still need the resumed run's measurements.

Deployed `4c4ce366e3a2` as release
`20261011T055516301Z-4c4ce366e3a2-42eaf353`, then resumed the original job through
its **Resume saved build** control. The extraction remains 42,525,664,610 bytes
with its original 2026-10-10T17:59:55.195Z modification time. Both checksum scans
passed. At 05:59:55 UTC the new graph compiler was running its reference scan,
5.1% complete, reporting approximately eight minutes left in that stage and a
fresh durable checkpoint. This is not an overall build ETA or a graph-throughput
comparison: coordinate lookup begins in the subsequent graph partitioning stage.
Atlas and `lemond.service` were both active; roughly 230 GiB was free before
removing the obsolete graph spool.

Validation: 145 Bun tests; Rust workspace tests plus the new coordinate recovery
test; TypeScript and host build; six forced native stops/resumes; 242 routing
cells byte-identical to the regional compiler; 5,339 display tiles and all
semantic parity checks passed. The host browser showed the new stage percentage,
ETA, checkpoint timestamp and stop/resume control.
