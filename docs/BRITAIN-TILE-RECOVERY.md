# Britain low-zoom tile overflow — 11 October 2026

The first Britain run failed while packing `tile/land/4/7/5`. Its 5,726 saved
fragments contained 851,046 records and 4,034,254 points (23,044,564 raw bytes).
Each batch was legal on its own, but the combined tile exceeded both the
500,000-feature and 3,000,000-point decoder limits.

A local replay of those exact server fragments reproduced the failure. There
were no duplicate compressed fragments. The overview tiler retained subpixel
land-use polygons: 235,236 records had zero signed area after quantization.
The overview tolerance of five coordinate units is only 0.039 pixels on a
512px tile at our 65,535-unit extent. This had preserved small regional footprints
but did not scale to country-sized inputs.

## Fix

`compactDisplayTile` applies an explicit display policy at z0–12: remove land/water
polygon exteriors smaller than one pixel of area on a 512px tile, together with
their holes. Retained exteriors and their nonzero holes keep their original bytes.
This uses the exterior/hole winding emitted by geojson-vt, not a test of a whole
multipolygon's net area. Detail tiles from z13 upward, buildings/heights, lines and
points are unchanged. Full-resolution source objects, search and routing are unchanged.

Filtering runs before new fragments are stored and again during packing. The
second application is idempotent and repairs existing spools without regenerating
the source batches. Invisible tiles are omitted from the archive. Safety limits
are unchanged; a genuinely oversized visible tile still fails with an explicit
message. This is level-of-detail filtering, not arbitrary feature-count truncation.

The exact failing tile now packs to **210,868 bytes and 645 records**. A read-only
server audit of all **29,589 land/water tiles at z0–12** passed the existing limits;
the largest retained point count was 242,204 and largest feature count was 26,404.

## Recovery

Britain job `f6b452bc-2f27-42da-a74f-e41ecc596c4a` retains verified receipts for
`transport.atlas`, `source.sqlite`, and `semantics.atlas`, plus its durable
`display-fragments.sqlite`. Normal resume verifies those files and reuses them.
Only display packing and the subsequent finalization/assembly need to continue.
No compiler identity bump or checkpoint deletion is necessary. Completed stage
artifacts are not modified by the fix.

Regression coverage includes an aggregate spool exceeding both old limits,
multipolygons and holes, unchanged detailed geometry and heights, empty tiles,
mixed old/new fragments, and continued enforcement of the decoder budgets.
