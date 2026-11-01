# Build storage incident — 1 November 2026

The LAN server's Western Europe build stopped at the configured 12 GiB floor (10 GiB reserve plus 2 GiB stopping margin). Free space was 11.99 GiB. This was a controlled stop, not evidence of a full filesystem or database corruption.

The four following jobs were rejected by admission estimates before compiling: Rhine–Alps, Alps–Danube, GCC satellite, and Iran satellite. Their UI state was `failed`, even though they had not performed a failing compiler pass. A storage-blocked queue state would describe this more accurately and avoid a cascade of misleading failures.

## Measured storage

Western Europe job: `b8272577-990e-4eca-85b1-839c7be9ba18`.

| Artifact | Bytes | Approx. GiB |
| --- | ---: | ---: |
| Source database (`source-v4.sqlite`) | 209188827136 | 194.83 |
| Coordinate store | 55917636834 | 52.08 |
| Completed routing archive (`transport.atlas`) | 48462983891 | 45.13 |
| Extracted regional PBF | 35804771599 | 33.35 |

The whole job directory occupies about 326 GiB. The source database has 51,071,491 4 KiB pages and zero free-list pages; vacuuming cannot reclaim unused pages at this point. It already compresses individual source-object and display-feature records.

The committed native source cursor is stage 1, 160,216,000 ways processed, source offset 28,748,138,756; the pass started at offset 22,625,015,880. The reported 46.46% applies only to this source-ways pass. Relations, indexing, semantic packing, display tiles and final assembly remain. A linear whole-build size/ETA extrapolation would be unreliable.

Routing is complete and receipted (SHA-256 `6f615b4be73dd8d261625a16092c48294312e27f8cc55388fd2e58647cb84bdb`). Source geometry has a durable native cursor, but is not yet a completed partitioned stage.

The planet PBF is already on the NAS at `192.168.0.213`, public share, `atlas/sources/planet-261005.osm.pbf`. NAS available space measured about 917 GiB. The SSD is a 467.88 GiB filesystem.

## Recovery performed

Removed only ordinary `target` compiler-output directories from 32 obsolete Atlas releases. Current and previous releases, symlink targets, source code, map files and all build checkpoints were preserved. The audit list is on the server at `/home/nixuser/atlas/shared/compiler-cache-cleanup-20261101.json`.

This increased SSD free space from 11.99 to 19.72 GiB. GCC and Iran satellite imports were resumed through the normal API without a storage override. Large vector jobs were left stopped pending a storage/area decision.

## Recovery options

For the adjacent-map demo, park the stopped Western Europe work directory on the NAS with a verified copy before reclaiming its SSD blocks, then build the smaller independent maps sequentially on SSD. Keep the source snapshot and routing authority unchanged. This requires a deliberate checkpoint relocation plan: native source identity includes canonical input path, size and nanosecond mtime. A naive symlink move can invalidate it.

For the full Western Europe area, reduce peak compiler working space before resuming. Candidate changes: immutable completed artifacts on NAS, bounded geographic source partitions, reclaiming stage inputs only after durable receipts, and final archive streaming to the chosen output volume. Do not casually relocate the writable SQLite database to the current GVFS/SMB share. Validate any remote working-store strategy explicitly.

The final deliverable remains one self-contained `.atlas` per map. Temporary storage placement is independent of that format requirement. Neither reducing the reserve nor removing old release caches supplies enough space to finish the current continental pipeline reliably.
