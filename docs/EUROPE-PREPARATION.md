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
The source library and existing regional import cache are currently separate:
continent source reuse enters through the compiler work below, not through a
pretend conversion of a raw PBF into an already usable map.

## Remaining compiler work

The present Rust display importer retains all node coordinates, relation state
and features; the TypeScript compiler then loads one intermediate JSON and
geojson-vt indexes. Transport import retains nodes and graphs per profile.
Lower zoom or a smaller output cap does not bound these allocations. The HM90S
has 30 GiB RAM; Atlas is limited to 20 GiB. A 95 GB source fitting on disk does
not make this pipeline suitable for full Europe.

The next implementation must build a disk-backed coordinate/reference index,
stream canonical features and partition tile/semantic construction. Build shared
graph cells from one snapshot with deterministic border identity before packaging
regional outputs. Preserve multipolygon members, turn restrictions, heights,
feature IDs and existing capability semantics. Record per-stage disk use and
peak memory, allow stage resume, and publish only verified complete outputs.

Then execute the saved Europe recipe against a crop of the cached planet,
assemble the resulting packages in the normal client composer, and measure
cross-partition client/server routing. PBF storage, temporary compiler workspace
and final Atlas capacity must be measured separately; no full-Europe build has
been claimed or silently started by this UI slice.

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
