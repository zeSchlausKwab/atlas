# Ocean water

The PBF importer recognizes inland `natural=water`, reservoirs and riverbank
areas. `natural=coastline` ways are open, directed boundary segments; treating
individual segments as polygons would flood land or leave gaps. The first Britain
build therefore had lakes and rivers, but no sea polygons. This was unrelated to
the low-zoom tiny-polygon filter.

The ocean step consumes assembled polygons from
[OSM water polygons](https://osmdata.openstreetmap.de/data/water-polygons.html).
They come from OSM coastlines and exclude inland lakes and reservoirs. They are
ODbL data and retain the existing OpenStreetMap attribution. For a strict shared
snapshot, assemble coastlines globally from the same planet PBF with osmcoastline;
a cropped PBF does not in general contain complete coastline rings.

## Add ocean to an existing package

1. Cache and fingerprint the provider's `water-polygons-split-4326.zip` (the
   existing `fetchSource` helper writes `{url,bytes,sha256}` to `.source.json`).
2. Clip the shapefile to the map's bounds with GDAL. For a polygon selection,
   use that polygon as the clip source. Coordinates must be EPSG:4326.
3. Run the bounded regional water step:

```sh
ogr2ogr -f GeoJSON ocean.geojson \
  /vsizip/ABSOLUTE/water-polygons-split-4326.zip/water-polygons-split-4326/water_polygons.shp \
  -spat WEST SOUTH EAST NORTH -clipsrc WEST SOUTH EAST NORTH \
  -makevalid -t_srs EPSG:4326

bun scripts/add-ocean.ts original.atlas ocean.geojson with-ocean.atlas water-polygons-split-4326.zip.source.json
```

The output must be a new path. The original archive remains untouched. SIGINT or
SIGTERM removes this command's partial output and temporary SQLite index. A hard
kill can leave `.part` / `.patch-*` scratch files; choose a fresh output path or
remove those explicitly after checking no writer remains. This incremental step
is restartable from the original file, not checkpoint-resumable.

The repair CLI above remains intended for existing regional archives. New large
builds can include oceans during compilation (below), avoiding a full-file patch
and unreachable superseded payloads.

## Integrated compilation

Configure the host with `ATLAS_OCEAN_SOURCE=/absolute/path/water-polygons-split-4326.zip`.
The adjacent `.source.json` contains `{url,bytes,sha256}`. The Nix runtime includes
GDAL; local hosts can install `ogr2ogr`. The host's cached-PBF chooser exposes
**Sea polygons · separate coastline snapshot** when the source is available.
The selection pins `{ocean:{sha256}}`; paths cannot be supplied by API callers.

Before the expensive PBF pass the compiler verifies the provider file, clips its
polygons to the exact selection, validates the geometry and saves a checksum
receipt. A polygon-only view removes zero-area line remnants from clipping while
preserving all polygon components and holes. The current single clip is bounded
to 512 MiB and 25 million points; larger areas need partitioned coastline input.
The Western Europe preflight was 530,446,129 bytes / 19,228,734 polygon points
before coordinate precision reduction. Its parsed input used about 2.12 GB RSS.
Tiling uses additional memory; this is not a whole-build memory estimate.

Queryable sea objects enter the same packed object store as PBF objects. Water
tiles enter the display spool in batches of 10,000. Cancellation rolls back the
unfinished batch; restart replays traversal but skips committed contributions.
All components are assembled once into the final self-contained `.atlas`.
Physical coastline ways retain the PBF identity; sea objects carry the separately
dated provider hash and clipped-geometry identity. Provider split/cut edges are
not physical coastline, and these surfaces do not provide shipping routing.

## Archive and reader behavior

- No new file-format version, client fallback, runtime basemap or renderer is
  required. Ocean polygons use normal `tile/water/z/x/y` records.
- New ocean records merge with existing inland water. Island holes and winding
  are retained. The Water toggle controls the whole layer and its requests.
- Existing non-water payloads and directory-leaf hashes remain unchanged. The
  original data region is copied once; replaced water payloads become unreferenced
  bytes. This deliberately trades a little disk space for a narrow, safe repair.
- SQLite tracks changed water entries on disk. Depth-first tiling releases
  geojson-vt descendants and awaits writes instead of queuing millions of tiles.
- The archive gets a new snapshot, but its transport graph identity is preserved.
  The manifest records both the coastline source hash and clipped-input hash.
  Separately dated coastlines are explicitly distinguished from the PBF snapshot.
- New ocean additions also retain queryable sea polygons in `objects/*`, with
  `water=ocean` and a separate source fingerprint. Island holes survive. These
  polygon edges include provider splits and clipping, so they are explicitly
  **not physical coastline**. Physical coastline is retained from PBF
  `natural=coastline` ways when Analysis source is enabled. No shipping graph is
  implied. Older ocean-patched archives need repackaging for this capability.

Validate the new archive before publishing it. For Britain:

```sh
bun scripts/verify-britain-water.ts with-ocean.atlas original.atlas
```

The probe checks North Sea / Irish Sea / Hebrides water, London and island land,
and an inland lake at multiple zooms. With the original path it also compares all
non-water directory hashes, capabilities, graph identity, and a streaming SHA-256
of the entire original data region. Then replace the hosted file atomically,
update its preparation record, and restart the server to close pinned readers.
Keep the previous file and record for rollback. Consumers must reopen the map
(or refresh) to use the new snapshot; old cached blocks are never mixed with it.

## Follow-up performance work

Uniform sea tiles contain only a few coordinates, but still have an entry for
every covered tile. A future format can represent uniform coverage or share
payloads. This repair intentionally uses today's fully supported layout. Measure
root-directory transfer separately from water geometry when evaluating it.

## Britain repair measured on 2026-10-11

- Original: 14,563,483,681 bytes, snapshot
  `39c0392ea1a04ccb835d1e39adb0c5402d80d1185a3a00272eaf9e54cb28db6e`.
- With ocean: 14,929,960,780 bytes (+366,477,099 bytes / 349.5 MiB / 2.52%),
  snapshot `cbc7046bada82b941847de1083c3bf80540d955f3c4d74cad523bf8c491cbef0`.
- 6,354,137 ocean tile contributions; about 13,300 tiles/s, 550–625 MiB process
  RSS during tiling on the Ryzen 4900HS. Page-cache memory is additional.
- 38 geographic coverage checks passed at z4–16. All 20,789 non-water directory
  hashes are preserved. The complete 14,051,501,949-byte original data region has
  an identical streaming hash in both files. Transport metadata is unchanged.
- Coast source: `water-polygons-split-4326.zip`, 906,194,294 bytes,
  SHA-256 `d0a3001e3846929110a7f7865377413a01daee293af2a5fa5ba3b8e59389b0b4`,
  provider Last-Modified 2026-10-11 03:46:48 UTC. The planet PBF is dated 2026-10-05.

The output is staged at
`/home/nixuser/atlas/shared/data/coastlines/britain-with-ocean.atlas`.
Publication was held because Europe job `f338f58d-7554-41c8-8424-56d841fb3d25`
was actively compiling. The existing service and Europe build were not restarted.
Candidate release `20261011T172841055Z-29c45b8c2b46-942d8bcf` passed deployment
candidate checks but was not activated. Reuse it with `bun run deploy --resume
20261011T172841055Z-29c45b8c2b46-942d8bcf` after there is no active preparation.
A snapshot-guarded, backup-preserving publication helper is staged beside the
output as `publish-britain-ocean.js`; it requires the service stopped and no
running/cancelling job records. Do not interrupt Europe without the user's choice.

Additional checks on the original Britain snapshot (whose operation payloads are
preserved by this repair):

- Client/server landmark search (`Admiralty Arch`), reverse geocoding, and a
  1/3-minute walking isochrone agree. Highest peak query returns Ben Nevis, 1345m.
- Walking across Westminster Bridge: 353.6m; client/server coordinates and cost
  agree. Cycling and driving from Charing Cross to the London Eye: 2417.9m and
  1854.3m respectively, also identical between client and server.
- **Open issue:** walking from `[-0.1275,51.5075]` to `[-0.1195,51.5034]` returns
  no-route after 60 states on both runtimes (snapped ways 1391137814 and 50149963).
  Cycling between `[-0.1235,51.5009]` and `[-0.1200,51.50055]` also returns
  no-route (snapped ways 1254907848 and 127170405). Investigate disconnected
  components / endpoint alternatives; these checks do not prove unrestricted
  routing quality.
- **Open issue:** `London` still exceeds the 64 MiB decoded search-read budget.
  Intersecting every query gram now removes unnecessary candidate-page reads,
  covered by a regression test, but common real matches are still scattered.
  A compact place-name / relevance index is the next search improvement; simply
  raising the memory budget would hide the layout problem.
- 167 Bun tests and TypeScript checks passed; client assets rebuilt. Visual
  browser verification was unavailable because the Mac was locked.
