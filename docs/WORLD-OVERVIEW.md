# Fast world overview and archive assembly

The Prepare tab has a separate **Prepare world overview** action. It uses
Natural Earth v5.1.2 at 1:50 million scale, pinned to commit
`f1890d9f152c896d250a77557a5751a93d494776`. It does not read the OSM planet.

The four inputs are countries, populated places, oceans and lakes. Their exact
sizes, URLs and SHA-256 digests are in
`packages/provisioning/src/world-overview.ts`. Downloads are length-bounded,
verified before atomic cache installation, and reverified on reuse. Input data
is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).

The result is an ordinary self-contained Atlas archive with:

- Land/water display tiles at zoom 0–6, including blue seas.
- 242 generalized country/dependency polygons, searchable and drawable through
  the existing boundary tools, with selected source attributes for visualization.
- 1,251 major-place label anchors. Client collision handling controls visibility.
- Source provenance and per-input hashes. Country IDs use
  `natural-earth/admin-0/<NE_ID>`; they never impersonate OSM objects.

Country polygons are available for analysis/drawing; default display tiles do
not add a new automatic border-line style. The dataset is generalized, uses the
source's boundary choices and historical population/economic estimates, and is
clipped to ±85° latitude. It has no municipal polygons, street/address search,
routing or detailed terrain. Older readers that require OSM-only boundary IDs
need the updated boundary validator. Country name search and containing-area
queries use the existing boundary index, not the address geocoder.

## Reproduction

```sh
bun scripts/world-overview.ts data/world-overview.atlas data/natural-earth
```

On 11 November 2026, the four inputs totalled **8,693,819 bytes**. A local cached
build plus verification took **0.82 seconds** and produced **3,464,050 bytes**.
The deployed server also completed the recipe: **3,488,970 bytes (3.33 MiB)**
in the library, then published its Hashtree revision. Its packing pass reported
0.89 seconds; source acquisition/publication are separate. Host metadata explains
the small size difference from the command-line fixture.

These measurements describe this fixed recipe on the development machine, not
an arbitrary OSM build. The server admission allowance is 1 GiB of working space
plus its existing reserve. The new job persists and dispatches through the normal
queue, publication and cancellation path; runtime disk checks remain active.

The detailed **World information visualization** OSM recipe remains separate.
Its reusable filtered PBF is retained. Generalized world cartography does not
replace municipal analysis or alter its source authority.

## Final assembly

`copyArchiveBlocks` verifies and copies stored compressed blocks without decoding
and recompressing them. A small SQLite descriptor spool on the working disk sorts
blocks by physical offset. Separate directory and 4 MiB payload read-ahead buffers
keep NAS access sequential. `StreamWriter` coalesces small writes into 4 MiB
batches and still publishes only after final directory/payload completion.

Hashes and codecs are preserved, cancellation and source mutation are checked,
and bad data never publishes a replacement. Final package roots can change when
layout changes. This does **not** add resumption within an unfinished assembly
pass; completed compiler artifacts remain reusable.

```sh
bun scripts/benchmark-assembly.ts
bun test tests/archive-copy.test.ts tests/stream-writer.test.ts tests/world-overview.test.ts
```

A 4,096-block, 26,075,257-byte local synthetic fixture took 1.307 s with decoding
and recompression versus 0.135 s with verified stored-byte copying (~9.7×).
The optimized input path made nine file reads totalling 26,568,746 bytes.
Both variants use the buffered writer. This is a CPU/local-I/O comparison;
NAS throughput and North Sea's completion time still require observation.

## Selective OSM world preparation

The OSM information-visualization recipe keeps water for display and administrative
boundaries for analysis. These are independent selections: enabling a water display
layer does not request a replicated, extractable water-feature index.

The semantic compiler now filters source-store classes before decompressing
geometry when search/street/POI semantics are not requested. A boundaries-only
analysis pass reads class 9; place labels still come from the locations table.
Both the partitioned and in-memory compilers apply the requested feature kinds
before calculating legacy cell coverage. This fixes the world-build failure
`Feature way/26530066 spans too many cells for this regional prototype`, which
was caused by indexing an unselected shape before discarding its cells.

This changes neither the file format nor completed-stage fingerprints. A failed
semantic pass can reuse its verified source database and filtered PBF, then rebuild
only the unfinished stages. Existing completed archives remain compatible. The
regional cell limit still applies to explicitly requested legacy feature families;
this fix does not silently omit oversized selected features or remove that limit.

Regression coverage: `tests/feature-selection.test.ts` checks family filtering,
source-stage reuse, selective decoding, preserved boundary geometry and place
labels, and repeated compilation from completed archives.

## Oversized display geometry

The next world pass exposed a genuinely selected water feature: Lake Nasser / Lake
Nubia (`relation/13985343`) expands to 37,417,092 bytes with 1,334,768 vertices.
It exceeded the old 32 MiB tiler input limit at about 84% of display processing.
The completed 3,657,379,329-byte semantic archive remains reusable.

Oversized display copies now take an isolated GDAL preprocessing path. It projects
to EPSG:3857, simplifies at one quarter of a 256-pixel tile pixel at the recipe's
maximum zoom, then projects back to EPSG:4326. Projection is a separate first pass
because [ogr2ogr simplification uses the source coordinate system and preserves
per-feature topology](https://gdal.org/en/stable/programs/ogr2ogr.html#cmdoption-ogr2ogr-simplify).
Original IDs and properties are restored after conversion. Analysis geometry and
receipted source artifacts are unchanged. The archive records this display policy.

Decompression is bounded at 128 MiB per source object; the result handed to the
JS tiler must still fit 32 MiB. If generalization cannot achieve that at the chosen
zoom, preparation fails with the object ID and a spatial-partitioning diagnostic.
It never increases tolerance until a shape fits, or silently drops a feature.
Scratch files and child processes are cleaned up on failure/cancellation. GDAL is
already part of the server's Nix runtime; local builds report an install instruction
if an oversized feature needs it and it is unavailable.

Both sequential and parallel tilers avoid fetching/decompressing unselected
geometry. Counts and durable `(cell,rowid)` cursors still cover all source records,
so existing display checkpoints remain valid, including trailing skipped records.
Tests cover cancellation, malformed selected data, skipped unselected data, worker
changes on resume, and GDAL preservation of holes, detached polygons and tags.
The GDAL test runs on the server when GDAL is absent on the development machine.

The failing lake's server verification reduced its display feature to 766,649
bytes and 31,592 vertices in 9.2 seconds at z6. Full world completion is a separate
acceptance step; this is a measured single-feature result.

### Crowded display tiles at the final zoom

The next world-build stop was `tile/water/6/15/21`: its valid individual fragments
combined to 4,983,364 points, above the unchanged 3,000,000-point tile decoder
limit. `geojson-vt` deliberately uses zero simplification tolerance at its
`maxZoom`; setting that to a coarse archive's final zoom (6) retained source
precision where display-scale geometry was needed.

New partitioned builds use an internal detail zoom of at least 13, while emitting
only the zooms requested by the recipe. This keeps the existing simplification
active at a coarse archive's final zoom. Detail archives retain their existing
full-detail final-zoom behavior.

Packing also recovers older saved fragments. If a tile below z13 exceeds the point
budget after subpixel filtering, its land/water polygons are simplified by GDAL /
GEOS at one quarter of a 512-pixel tile pixel, in integer tile coordinates, with no
CRS transform. The packer checks that every feature, polygon component and hole
survives (retaining original record bytes when a candidate would lose parts or
produce degenerate rings); restores exterior/hole winding; and applies the original feature, point
and byte limits. Other geometry classes are unchanged. There is no tolerance
escalation, dropped-feature fallback or change to the analysis/source geometry.
Per-feature topology is preserved; separate features' shared boundaries are not
simplified jointly. Detail-zoom overflow still requires spatial partitioning.

The real failing tile reduced to 246,732 points while retaining all 4,043 features
and 38,265 rings, in about 15 seconds on the server. Its encoded fragments went
from 20.10 MB to 1.19 MB. This recovery uses the completed display spool and does
not require repeating extraction, semantic compilation or source tiling. Scratch
files are removed on success, cancellation and error. Local tests cover maximum
zoom behavior and the unchanged detail guard; server GDAL tests additionally
exercise over-budget packing, holes, separate polygon components, untouched road
records, and cancellation cleanup.

A read-only preflight of all 4,448 saved display tiles found five over-budget
water tiles, all at z6. All five passed recovery with feature and ring counts
unchanged; one original feature was retained because its simplified candidate
contained a degenerate ring. The preflight finished with zero remaining point,
feature or block-size failures. This validates packing inputs, not completion of
the final assembled archive.
