# Host file imports and composition

Open `/host#imports` on your Atlas server. Select one or several files:

- **Raster MBTiles:** JPEG/PNG tiles with geographic metadata. The server converts
  them to a self-contained raster Atlas, preserving the encoded pixels and source
  metadata. See [supported MBTiles inputs](MBTILES.md). Metadata must include bounds;
  use the CLI with `--bounds` if they are missing. Vector MBTiles are not supported.
- **Atlas:** existing maps are registered without changing their bytes, snapshot,
  routing, search, extraction, custom blocks or imagery. Directory integrity and
  every payload block's stored SHA-256 are checked before publication.
- **PNG/JPEG:** follow **Place an image** to anchor a single image and build its
  tile pyramid. This remains a separate placement workflow.

Files upload sequentially in 8 MiB pieces. Each acknowledged piece is saved to
server disk. Pause, close the page, or recover after a lost connection by selecting
**the same unchanged file** again; filename, byte length and last-modified time
identify its saved upload. The server's acknowledged offset determines where to
continue. Discard removes only an unfinished upload. Local originals are untouched.

After the upload finishes, the server queues conversion or verification in
**Builds & checkpoints**. The browser can close. Multiple uploaded files share the
normal sequential preparation queue, so a large import does not block serving maps.
Progress reports the current phase and its count, with a per-phase approximate ETA.

A stopped/failed import keeps its staged source for **Resume saved build**; MBTiles
conversion currently restarts its conversion pass, while Atlas verification restarts
its checksum scan. Neither requires re-uploading. Finished jobs remove staged input;
the resulting Atlas is the retained artifact. Delete dataset removes that output
through the normal library workflow. Existing published files are never overwritten.

Storage estimates account for the upload and, for MBTiles, temporary packing plus
the final archive. They are approximate, especially for deduplicated SQLite inputs.
The existing **Start anyway** dialog can override the estimate. The actual 10 GiB
free-space floor still pauses uploads/builds. There is no arbitrary file-size cap;
filesystem, disk space and supported-format constraints still apply.

## Two kinds of composition

**One view from separate files:** check Compose on the maps in the library, then
open **Compose N selected maps**. The client reads visible layers from each archive
and offers individual raster visibility and opacity. This does not create a merged
archive or make unrelated routing snapshots compatible.

**One file with imagery embedded:** choose **Manage imagery** on the target map,
add a layer from an imported raster map, review and queue the new revision. Only
intersecting raster tiles are copied, alongside the target's unchanged capabilities.
The original is retained, and its served revision switches after success. See
[imagery amendment contracts](RASTER-AMENDMENTS.md). Hashtree publication is explicit.

## Programmatic upload

These endpoints use the same trusted-host administration policy as the console.
Every mutation requires an `Origin` header exactly matching the server's origin.
No endpoint accepts a local path or an arbitrary remote URL.

| Request | Purpose |
| --- | --- |
| `POST /admin/imports` | Create a session with `{filename,size,modified?,allowStorageRisk?}`. Returns `id`, `offset`, `chunkBytes` and metadata. |
| `GET /admin/imports` | List unfinished saved uploads. |
| `GET /admin/imports/:id` | Get the acknowledged offset and, after handoff, `jobId`. |
| `PUT /admin/imports/:id?offset=N` | Send up to `chunkBytes` raw bytes as `application/octet-stream`. Offset must match; response acknowledges the new offset. |
| `POST /admin/imports/:id/finish` | After all bytes arrive, queue the import; returns `202 {jobId}`. Retrying this call returns the same job. |
| `DELETE /admin/imports/:id` | Discard an unfinished upload. Queued imports use the normal job lifecycle. |

A stale offset returns 409: GET the session and continue from its saved offset.
An estimate warning returns 409 with `storageWarning`; repeat session creation with
`allowStorageRisk:true` if desired. Actual low free space returns 507 and keeps
received chunks. Incomplete or unsupported input fails without publishing a map.
Malformed files that reach the queue surface a failure in Builds & checkpoints.

Upload session files live in `ATLAS_DATA_DIR/imports`; staged build files live in
`ATLAS_DATA_DIR/hosted/<jobId>.work`. These are on the same storage volume: a hard
link transfers ownership to the queue without duplicating a potentially huge file.
On recovery, bytes beyond the last acknowledged offset are truncated. The queue
record is persisted before the upload staging link is removed. Atlas publication
also uses a hard link; verified file contents are never rewritten in place.
