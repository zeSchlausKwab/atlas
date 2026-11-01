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

## Selected follow-up

The user selected the two smaller adjacent builds, retaining Western Europe paused. Both satellite imports subsequently completed. Free space after their cleanup was about 20 GiB.

The recovery utility `scripts/park-checkpoints.ts` moves explicitly selected inactive checkpoint files, verifying SHA-256 by reading the NAS copy before unlinking the original. It keeps a local `checkpoint-parked.json` manifest and an archive manifest. The host refuses resume/delete while that marker exists and displays transfer progress. An explicit verified restore clears the marker. The extracted PBF remains at its original path and retains its original mtime, so native checkpoint identity is preserved.

For this incident, park `compiler/source-v4.sqlite` and its rollback journal under the NAS `atlas/checkpoints/western-europe-20261101/`. This reclaims approximately 195 GiB; coordinates, completed routing and the PBF remain on SSD. The writable SQLite database is **not** opened on the NAS. Follow-up job IDs are Rhine–Alps `569e36a3-7e75-4b44-ba77-5b43c42b546c` and Alps–Danube `1c976fbf-55b3-4ee5-9e42-ea63168e3b9e`. They are submitted sequentially through the normal queue once parking is complete, with no storage override.

To restore later, stop the job and provide enough SSD space for the archived files plus the reserve:

```sh
bun scripts/park-checkpoints.ts --restore \
  --job b8272577-990e-4eca-85b1-839c7be9ba18 \
  --work /home/nixuser/atlas/shared/data/hosted/b8272577-990e-4eca-85b1-839c7be9ba18.work
```

Archive files are retained after restoration. A transfer interrupted by a caught I/O error can be rerun with the same arguments; already verified files are checked and reused. A hard process kill can leave `checkpoint-parking.lock`: confirm the old process is gone before removing that lock. Do not remove the guard manifest to bypass restoration.

Validation: 390 Bun tests passed; TypeScript and the host build passed. An 8 MiB probe was copied to the actual NAS, fsynced, SHA-256 verified, restored and compared byte-for-byte before starting the real transfer.

The transfer was started as `atlas-park-western-20261101.service` (user systemd service). It continues without a browser or SSH session, retries caught failures with a 60-second delay, and queues the two follow-up jobs only after verification and local reclamation. At 06:38 UTC, 7.54 GB had copied successfully. Use the host activity card for live copy/verification progress or `journalctl --user -u atlas-park-western-20261101.service`. This records a running recovery, not a completed archive or completed vector builds.
