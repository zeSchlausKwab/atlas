# Atlas amendments, raster families and extensible operations

Accepted direction: 2026-10-29. This document distinguishes shipped work from planned work.

## Product contract

A published Atlas revision is one immutable, self-contained file. Data families can
be built independently. Consumers fetch only the families and spatial blocks they
need. An operation declares its data dependencies and execution location. The same
family can live in a larger archive or a separate archive composed by the client.

Amending a map produces a new revision; it never overwrites bytes behind a published
snapshot or Hashtree root. Existing clients remain pinned. Publication of the new
revision is explicit. Old revisions remain independently usable until retired.

## Milestone 1 — add routing without rebuilding the map

Status: implemented locally; remote activation deferred while the large build runs.

Deliver an amendment planner and writer shared by CLI and host console. First
supported input: a compatible Atlas archive containing precompiled RCL2 transport
cells. The initial donor workflow lets a host select missing
travel modes, review reuse/import/storage estimates, and queue a new file. Normal
preparation jobs and amendment jobs share the persisted single-worker queue.

- Preserve every original payload block, including unknown extension blocks,
  byte-for-byte; verify hashes while copying. Preserve map coverage and zooms.
- Select only requested routing cells for the original polygon and padding.
- Require the exact source PBF fingerprint and covering donor geometry. Existing
  transport data also requires the same compiled graph identity: the same PBF
  alone does not prove compatible segment numbering.
- Reject stale snapshots, absent profiles, replacement of existing profiles,
  legacy routing mixtures, incompatible graphs and insufficient coverage.
- Preserve graph identity across archive revisions. Record parent and donor
  snapshots, profiles and builder version in amendment provenance.
- Show byte/cell progress; cancel safely. Requeue starts the copy again in this
  first slice. No PBF scan, vector regeneration, geometry recompression or second
  downloaded source is necessary when the donor already contains routing.
- Keep publication explicit; the completed revision appears as a separate library
  entry and uses the existing Hashtree publisher.

Acceptance: real routing and isochrones from the amended file, matching donor
results; matching hashes for all original display/feature/custom blocks; both old
and new files reopen independently; rejected incompatible inputs and cancellation
leave the original untouched. Verify through CLI, host queue and HTTP routing.

### Retained PBFs and host capability composition — implemented locally

The map library now presents capability checkboxes directly on each map. The host
reviews and applies a desired set; a new immutable revision is built in the persisted
queue. Existing selected blocks and unknown custom blocks keep their compressed bytes.
Unchecked families are omitted. The previous map stays served throughout preparation;
a successful replacement retires it from the catalog and HTTP serving, retaining its
file and a reactivation action. Hashtree publication of the replacement stays explicit.

Regional Geofabrik downloads are retained and listed alongside planet/Europe inputs.
Both the old hosted-source cache and the new common source cache are discovered without
copying data. Delete removes managed cached bytes or a NAS registration, never external
NAS bytes. Active and queued source dependencies block deletion.

Missing families resolve a matching retained PBF by exact source ancestry. If absent,
a compatible Atlas donor is considered, then the original pinned dated download can be
retried and checksum-verified. New source versions cannot be substituted implicitly.
Routing-only builds skip display and semantic construction. Adding a mode rebuilds all
selected graph modes together; independently compiled graph identifiers are not mixed.
The PBF builder retains extraction receipts and compiler checkpoints across failures.

Built-in choices include display layers, grouped labels, each transport mode, search,
reverse streets, peak queries, grouped feature extraction, boundaries and tagged source
objects/relationships. Labels and standard feature pages remain grouped to avoid merging
incompatible local page ordinals. This is a built-in family adapter, not yet the general
plugin descriptor system below. Raster amendments now use the same queue through a separate imagery planner.

### Verification — 2026-10-29

The local Liechtenstein rehearsal retained **6,533 original blocks** byte-for-byte.
The geometry/extraction archive was **11,902,562 bytes**; adding all three modes
produced **18,475,167 bytes**, including **242 graph cells / 6,558,882 bytes**.
Local route coordinates, length and cost matched the donor; the HTTP route endpoint
returned a route from the amended archive. This is a small local proof, not a
large-archive performance guarantee.

`bun run verify:amendment` repeats the proof after local setup. The CLI is
`bun run map:amend --help`. Host UI verification covered reviewed plans, edit
invalidation, actual queued execution, retained original downloads, existing-mode
disabling, HTTP routing and a 390-pixel mobile dialog, with no browser exceptions.
No changes were deployed to the busy LAN server.

The Madeira PBF rehearsal reused the retained **407.08 MiB Portugal PBF**. It
preserved all **14,222 original blocks** and grew from **19,219,219 bytes** to
**105,083,632 bytes** after adding three transport modes, place/address search and
reverse streets. HTTP tests found routes through Funchal in each mode, produced a
walking isochrone, found Funchal by name and identified Avenida Arriaga from coordinates.
The original remained served during construction and was retained locally afterward.

## Milestone 2 — extensible family catalog and build dependencies

Status: descriptor foundation implemented locally; general builder/plugin dependency planning remains planned.

The optional `families` manifest field and capability discovery now expose versioned family descriptors: ID, schema, encoding, spatial coverage,
resolution/zooms, source provenance, attribution/licence and dependency fingerprints.
Keep existing archives readable through adapters for current built-in families.
Unknown optional families remain copyable even when a consumer cannot use them.

Distinguish stored data, installed host operations and locally executable operations.
A code-only operation does not change the archive hash. An index or data addition
creates a new archive revision. Builders record source, configuration and code
identities so the planner can reuse or invalidate derived blocks deliberately.

Raster descriptors add CRS, transform/tile matrix, bands, numeric type, units,
no-data/mask values, resampling rules, acquisition time and vertical reference when
applicable. Different family provenance is allowed; visual composition does not
require shared routing identity. Coverage is family-specific.

## Milestone 3 — visual raster delivery

Status: delivery/composition, PNG/JPEG uploads and embedded raster amendments implemented locally.

`demo:raster` retains 148 Natural Earth/OpenFreeMap PNG tiles around Europe at z0–6
in an 18.6 MiB standalone Atlas. Raster families have validated versioned descriptors
(projection, matrix, tile dimensions, imagery kind, extent, zooms, provenance, licence).
A paged `raster/<id>/<z>/<x>/<y>` namespace supports ordinary verified range reads.
`raster:import` accepts a local XYZ PNG pyramid and emits an immutable archive.

The existing consumer renders them through a bounded Canvas image plane with the
same camera as vectors, beneath labels. Composer opacity controls selective loading;
zero stops new reads. Cached tiles redraw in cache-only mode. Browser verification
combined relief from port 3182 and vectors from port 3181 with 18 range requests,
confirmed rendered image pixels, zero-opacity hiding, and cache-only restoration
without further requests. Existing vector archives and all 318 tests still pass.

This proof uses the provider's already tiled imagery, so it needs no local GDAL.
It is not numeric elevation or a full high-resolution terrain import. The original
GeoTIFF pipeline, clipping/export of raster families,
GPU textured rendering and more advanced image registration remain below.

Import the 24.01 MB Natural Earth shaded-relief source into a standalone
`relief.atlas`; create tiled overviews and preserve attribution/provenance. Add
selective raster reads and textured rendering with layer order, opacity and blend
controls. Compose it with an existing vector map, then embed selected relief blocks
in an amended regional archive. Both forms should render equivalently and work
without a remote provider after the necessary bytes are cached.

The current OpenFreeMap Liberty preview already uses Natural Earth raster relief
below z7. This is rendered imagery, not numeric elevation.

Sources checked 2026-10-29:

- https://tiles.openfreemap.org/styles/liberty
- https://www.naturalearthdata.com/downloads/10m-raster-data/10m-shaded-relief/
- https://www.naturalearthdata.com/about/terms-of-use/ (public domain)

### Embedded imagery revisions — implemented locally

**Map library → Manage imagery** offers per-layer inclusion, names and pixel sources.
A complete desired raster set supports adding, replacing and removing layers. Review
shows copied/imported data, replacement/removal and workspace allowance. The persistent
queue keeps all inputs pinned and protects them from deletion. A successful revision
retires its predecessor from serving while retaining its file; publication to Hashtree
remains an explicit action.

The writer scans directory pages without collecting the entire block directory,
verifies stored payload hashes, and preserves all non-raster bytes unchanged. Existing
transport graph identity survives the new archive identity. Imported images retain
independent attribution, licence and donor lineage. Family descriptors are optional;
old archives get an adapter view, and unknown custom descriptors survive amendments.
Descriptors describe data and never install or execute plugins.

Client composition has independent raster visibility/opacity with persistent/shareable
settings. Hidden imagery stops scheduling reads. This does not yet implement append-only
physical updates, arbitrary polygon pixel masks or image-source rebuilding.
See [the API and verification](RASTER-AMENDMENTS.md).

## Milestone 4 — georeferenced image uploads

Status: north-up PNG/JPEG proof implemented locally.

The host console's **Upload imagery** section accepts PNG/JPEG, a name, attribution,
licence and a rectangle (drawn on the preview or entered as west/south/east/north).
The image is stretched across that rectangle in Web Mercator. Placement can be
previewed over OpenFreeMap or a plain offline background. This manual registration
is not surveyed accuracy; one anchor alone is insufficient.

The browser applies image orientation and normalizes the upload to PNG. The server
validates dimensions, bounds and the normalized-image hash, then queues a persistent
background job. It builds transparency-preserving overviews and XYZ tiles, deriving
the maximum zoom from image resolution, and publishes one immutable standalone
`.atlas`. All runtime pixels, overview tiles, registration, attribution and licence
are inside that file. No source-image service is needed to display it afterward.
The source-image hash identifies the normalized PNG, not the original JPEG bytes.

Upload progress is followed by tile/packing progress in **Builds & checkpoints**.
Stopping retains the uploaded PNG and completed tiles; resuming reuses those tiles.
Temporary input and tiles are removed after successful publication. The library
supports serving, download, deletion, explicit Hashtree publication and composition
with vectors. Image maps do not acquire routing or semantic features from their pixels.
Raster attribution is visible on the composed map, including the uploaded licence.

The prototype accepts at most 64 MiB and 32 megapixels per image, with derived zooms
up to z18. These are decoder/workspace bounds, not output-budget sliders. Disk estimates
use the existing explicit **Start anyway** flow and runtime low-disk checks. Multipart
uploads require the same administration/origin checks as other host mutations; ordinary
JSON requests retain their smaller body limit.

Verification: a transparent **1024 × 768** synthetic image produced **27 tiles at
z0–13** in a **24,687-byte** archive. Browser checks covered JPEG normalization, PNG
upload, background publication, composition, opacity, visible attribution, cached
redrawing with network reads disabled and a 390-pixel host view. Import tests cover
pixel geography/alpha, cancellation/resume, changed-input rejection, immutable output,
request bounds and authenticated host publication/reopening/deletion.

Next: GeoTIFF georeferencing, rotation/corner transforms, control-point alignment,
raster region exports. These require explicit resampling
and accuracy contracts; they are not implied by the current rectangle registration.

## Milestone 5 — numeric terrain and portable operations

Status: planned.

Use a small Alpine Copernicus GLO-30 sample. Preserve numeric elevation separately
from display imagery. Prove local point sampling and route profiles first, followed
by hillshade, slope, contours and 3D terrain. Report surface-model limitations,
resolution and no-data coverage; GLO-30 includes vegetation and structures.

Source: https://copernicus-dem-30m.s3.amazonaws.com/readme.html

Expose operations through the existing schemas, progress/cancellation, result
references, HTTP and ContextVM interfaces, with client execution when supported.
A host selecting a tool should see whether it can be enabled directly, needs an
index, or requires an import/amendment. A later installer can offer portable code
with explicit trust and permissions. Discovery never silently executes arbitrary
code. Host credentials/live services cannot become offline data by packaging them.

## Physical format and Hashtree follow-up

Current amendments reuse compressed payloads but stream-copy them into a new file.
The front catalog may change payload positions. Hashtree currently uses fixed-size
64 KiB leaves, and persistent caches include snapshot identity: cross-revision byte
reuse is not automatic even when Atlas block hashes match.

Design a future version with stable payload positions and an appendable catalog or
commit record, immutable publication, pinned lengths/manifests, crash recovery,
optional copy-on-write staging and compaction of superseded blocks. Prototype and
measure this before migrating large archives. Logical family design should not
force that physical migration immediately. Final exports remain self-contained;
staging files and external source PBFs are build inputs, not runtime dependencies.

## Execution and deployment

Use local small fixtures and existing Vienna/Liechtenstein maps for development.
Do not restart the LAN host while Western Europe and its dependent builds run.
Build and test host assets locally; activate a remote release only once safe.
Do not modify published archives, running compiler checkpoints or the dirty local
`.env.example`. Commit focused milestones. Large raster or PBF downloads are not
needed for milestone 1.

### Host storage warnings

The host console no longer asks for output or source-download caps. It shows the
inspected PBF size and a rough workspace allowance, independent of the final
file size. Cached-source allowances are deliberately coarse until extraction;
they are not predictions. A submission that exceeds available disk space returns
a structured warning. **Start anyway** explicitly accepts that estimate for the
saved job, including its queued dispatch; it does not disable runtime low-disk
checks. Source downloads, map preparation and capability revisions share this
flow. Explicit CLI/API byte ceilings remain supported for automated callers.
