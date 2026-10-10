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
