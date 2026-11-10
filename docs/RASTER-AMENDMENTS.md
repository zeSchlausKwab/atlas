# Raster amendments

Implemented locally on 2026-10-29. One finished `.atlas` contains vector, semantic,
routing, custom and raster payloads. The input archives are build sources only.

## Host workflow

1. Upload/register a raster archive in the host library (PNG/JPEG upload or XYZ import).
2. Open **Manage imagery** on an existing map.
3. Keep, rename, replace, add or remove imagery layers. Removing means unchecking
   inclusion in this new revision; the original archive is retained.
4. Review copied/imported bytes, changed layers, coverage and workspace allowance.
5. Queue. The original stays served until the new file has been verified. The library
   switches to the replacement and retains the old revision with a reactivation action.
6. Publish with Hashtree explicitly when ready. New readers select the new snapshot.

The client composer controls each raster layer independently. Visibility and opacity
are part of saved/shared compositions. Old view links with source-wide `rasterOpacity`
remain readable and provide the initial per-layer opacity.

## Programmatic API

Use the same host administration access and same-origin JSON policy as other mutations.
`POST /admin/preparations/raster-plan` returns a review plan without writing an archive.
`POST /admin/preparations/raster` accepts the same JSON and queues a revision (HTTP 202).
Source IDs are hosted library IDs or `demo`, never arbitrary filesystem paths/URLs.

```json
{
  "targetId": "<hosted-map-id>",
  "targetSnapshot": "<64-character-snapshot-hash>",
  "name": "My map with survey imagery",
  "maxBytes": 1073741824,
  "layers": [
    { "id": "existing-relief", "name": "Relief" },
    {
      "id": "survey",
      "name": "Survey imagery",
      "sourceId": "<hosted-image-map-id>",
      "sourceSnapshot": "<64-character-snapshot-hash>",
      "sourceLayer": "image"
    }
  ]
}
```

`layers` is the complete desired raster set. An entry without a source retains an
installed layer. A source entry imports pixels; an existing target ID replaces that
layer, while a new ID adds one. Omitted installed layers are removed. `layers: []`
removes imagery while preserving other data. Multiple donors are supported. IDs must
be distinct, names nonempty, and the prototype supports at most 32 raster layers.

The plan reports reuse/import byte and block totals, removed/replaced IDs, final raster
descriptors, estimated output/workspace and warnings. Snapshot checks run again when
queued work executes. `maxBytes` is an explicit API ceiling; the UI uses no user-entered
size cap. The standard structured storage-warning/`allowStorageRisk` flow applies.
Runtime low-disk checks remain enabled.

Poll `/admin/preparations` for byte/index progress. Existing job `cancel`, `resume` and
`delete` endpoints apply. Cancellation/crash recovery discards partial output; resuming
repeats copying. It does not regenerate vectors, routing, semantic indexes or images.
Active/queued target and donor dependencies cannot be deleted.

## Data and coverage contract

- Imports copy verified compressed bytes without decoding/recompression.
- Whole XYZ tiles intersecting the target **bounding rectangle** are included. The
  layer extent is intersected with that rectangle; rendering clips to this extent.
  Arbitrary selection polygons are not pixel masks in this version.
- Raster projection, tile matrix, encoding, zooms and original image registration
  survive. `raster.provenance` records immediate donor snapshot and original layer ID;
  original attribution/licence and normalized-image hash remain available.
- Imagery provenance is independent of OSM. Adding pixels does not expand routing,
  search or feature coverage, and does not make imagery numerically queryable as a DEM.
- Existing non-raster payload hashes, compression and raw lengths remain unchanged.
  Transport graph identity is pinned when previously implicit in the old snapshot.
- The writer streams directory leaves, copies bounded blocks into a new file, verifies
  the saved metadata, then publishes without overwriting an existing output. Original
  files are retained. There is no append-only update or cross-revision Hashtree leaf
  reuse guarantee yet; adequate space for the new full archive is still necessary.

## Optional family descriptors

Amended files include `manifest.families`; `/api/capabilities` derives the same catalog
for older archives. Each descriptor has ID, descriptor/schema version, encoding,
non-overlapping block prefix, coverage/zooms, source attribution/licence, provenance
fingerprint and dependency fingerprints. Unknown custom descriptors and their blocks
survive amendments. Known descriptors follow final manifest changes at serialization.

This is descriptive groundwork. Independent copied imagery has no data dependencies.
A general plugin builder registry, configuration/code fingerprints, dependency invalidation
and portable code installation are future work. A descriptor never executes code.
The existing vector/semantic region-excerpt adapter omits imagery and custom families;
use imagery amendments for packaging until raster region exports are implemented.

## Verification

`bun test tests/raster-amend.test.ts` covers two-layer add/replace/remove, immutable output,
stale snapshots, bad coverage/IDs, cancellation, corrupt donor bytes, preserved custom
compressed bytes, routing/isochrones/search, family descriptors and host queue publication.
After deleting both original input files, a fresh reader and engine use only the result.
The queue test uses a large manifest to check completion-message flushing before worker exit.

The local browser rehearsal combined real Liechtenstein vector/navigation/search data
and two layers from the synthetic uploaded image in **22,745,969 bytes**, preserving
all **6,092 original payload blocks** and transport graph identity. HTTP routing
and Vaduz search passed. Browser checks covered reviewed-plan invalidation, queued
publication, old-revision retirement, visible raster pixels, independent visibility and
opacity, cached redraw with no new requests, shared-link state restoration and the mobile dialog. Full Bun regression
suite: **332 passing tests**. The LAN server and its large builds were left untouched.
