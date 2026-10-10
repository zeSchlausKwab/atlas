# Europe demo preparation

Target agreed on 2026-10-10: full Europe at z0–16, all supported geometry, labels,
walking/cycling/driving routing and isochrones, location search, nearest street,
peak queries and extractable source features. The user chose full detail rather
than a reduced overview, and authorized predownloading the planet PBF.

## Host UI workflow

1. Open `http://192.168.0.179:3100/host`. Trusted LAN administration is configured
   explicitly; the public map client remains a separate application.
2. Source library → Whole planet → Check download. Inspect the pinned date,
   exact bytes and disk headroom → Download PBF to server. Pause/Resume retains
   partial bytes. The transfer and checksum stages appear here; closing the
   page or deploying the map server does not stop the separate download unit.
3. Configure full Europe · z0–16 loads the provider extent and selects all
   currently supported capabilities. Edit the same capability controls used by
   regional preparation and save the recipe to the server. It reloads on return.
   The output cap is a budget, not a predicted file size.
4. The current UI explicitly marks the continent compiler as pending. A cached
   PBF or saved recipe is not an Atlas map and is never advertised in the catalog.
   Existing regional preparation, serving and composition remain available.

## Source snapshot

Official OSM source: `planet-261005.osm.pbf`, currently redirected by the provider
to its EU S3 mirror. HEAD on 2026-10-10 reported 95,244,184,503 bytes
(95.24 GB / 88.70 GiB), published 2026-10-08. Published MD5:
`d3b708ffc28873cf24a053e092dfd731`. The worker checks this after the download and
records its own SHA-256. These hashes identify a source snapshot; the dated source
does not silently change to the next weekly file.

The host also offers a Europe-only download, inspected live from Geofabrik.
Verified sources now appear in **Prepare a map → Data source**. The
**Vienna–Bratislava · cached PBF** preset uses the local planet, z0–16 and all
capabilities. No regional PBF download is needed.

## Cached-source compiler slice

`packages/provisioning/src/cached-build.ts` owns the build lifecycle:

1. Validate the cached source receipt, immutable source identity and recipe.
2. Smart-extract a padded regional PBF and check node references.
3. Compile one shared routing/semantic root and z0–11 overview.
4. Extract and compile z12–16 geometry in z9 partitions with a guard band.
5. Copy each detail tile from its sole owning partition, copy the canonical
   graph/search/labels/features once, verify input blocks, and assemble one archive.
6. Select the final polygon and publish it through the existing map catalog.

Both Rust importers now store sorted node coordinates in a private temporary
file with a read-only memory map. Sparse node IDs are binary-searched; duplicate
or unsorted IDs fail explicitly. Selected builds skip the unused legacy walking
graph. The source PBF is never loaded as one buffer.

Each completed extraction/compilation/assembly stage has a SHA-256 checkpoint.
Stop retains completed work; resume verifies it and continues at the first
unfinished stage. Server restarts leave a resumable failed job. Recipe/compiler
version changes and corrupt checkpoints are refused. Closing the browser does
not stop a build; deployment still refuses an active preparation. Checkpoints
are removed after successful publication. Planet downloads remain independent
systemd jobs; compilation is currently a child of the Atlas server.

Regional admission limits: 16 z9 display partitions, 100,000 candidate tiles,
and a 256 MiB extracted PBF. Input-size and disk checks stop oversized extraction;
source storage preserves 60 GiB free. These are conservative prototype guards,
not a guarantee of RAM use. Full graphs, semantic feature state, JSON indexes and
the final block directory still have regional in-memory components. The 20 GiB
service memory limit remains the backstop. Source bytes fitting on disk does
**not** yet make full-Europe compilation available.

Run `bun run verify:cached-build` for a real PBF integration test: stop after
extraction, resume, package all capabilities, verify every final block and route
across a display partition boundary in all three modes. Unit tests additionally
check partition ownership, checkpoint corruption and verified-source admission.

## Remaining compiler work

Stream canonical feature/relationship state; partition graph construction with
stable global edge identity; spatially partition search and geocoding; bound the
writer's directory memory. Measure disk/RAM requirements on progressively larger
regions. Then execute the saved full-Europe recipe. The current UI continues to
save that recipe without claiming continent compilation is implemented.

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
