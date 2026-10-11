# Host preparation demo

Updated 2026-10-11. LAN host console: `http://192.168.0.179:3100/host`.
For local development run `bun run server`, then open `http://127.0.0.1:3100/host`.

## Try Britain from the cached planet

Open `http://192.168.0.179:3100/host?area=britain`. The link selects the verified
planet input and fills an editable Britain starter rectangle when that source
is available. It never submits a build. The 32 GiB output limit is a user budget,
not a forecast of output size. Stored zooms default to z0–16.

1. **Choose the source.** Three source types replace the mixed dropdown:
   - **PBF on this server:** a checksum-verified cached planet or regional PBF.
     Extract an area without another download. The planet is global; a regional
     PBF cannot supply data outside its actual coverage.
   - **Download a region:** draw an area, inspect the covering Geofabrik region,
     then download that whole PBF and crop it locally.
   - **Existing Atlas map:** choose the installed base map or any ready library
     dataset. Its existing zooms, extent and capabilities bound the new package.
2. **Draw your area.** Click two opposite corners for a rectangle, or click
   polygon corners then **Finish polygon** / Enter. Undo removes the last corner;
   Escape stops drawing; Space adds the map centre when focused. The **Britain
   rectangle** shortcut includes Ireland and nearby coasts, not just a national
   boundary. Replace it with your own rectangle or polygon as needed.
3. **Choose what’s inside.** Presets include map display, geometry only,
   water/buildings, and all capabilities. Every checkbox remains editable;
   manual edits switch the preset to Custom. Summaries show selected routing,
   search and extraction categories even when their sections are collapsed.
4. Review the source-to-map summary and live disk allowance. For cached planet,
   press **Build & host map**. For Geofabrik, first **Find covering download**,
   then review its name and size before starting. Builds run independently of
   the browser. Stop cached-source builds with **Stop & keep checkpoints**;
   resume them from the Builds section. No build is started by choosing a preset.
5. The library offers open, download, capabilities, composition, **Use as source**
   and **Delete dataset…**. Deletion asks for confirmation, removes the package,
   its job record and saved workspace, and removes it from the public catalog.
   Source PBFs and independent child maps remain. Running builds, their Atlas
   inputs and the configured base map are protected. Failed/stopped build
   workspaces can also be deleted. An interrupted deletion completes on restart.

OpenFreeMap supplies only the preview. Coordinates and preview-provider options
are under the map. Atlas mode can instead preview the selected dataset using our
own renderer. Source-file downloading is separate maintenance, collapsed under
**Source files & downloads**. “Europe · full dataset” was a build preset, not a
fourth data source; it is no longer a special UI path. Europe can be drawn from
planet or built from a verified Europe PBF through the same flow.

The current Europe build is stopped with checkpoints preserved. Britain has not
been started: the user chooses the final capabilities and starts it manually.

## Worldwide PBF acquisition

A standard planet PBF has no geographic byte-range index. The **Download a region** option chooses the smallest covering Geofabrik region **by geographic area**, including the requested routing padding and an extra cell guard. Coverage is tested against the actual provider polygon, including holes and concavities. The whole regional PBF is downloaded before cropping; selecting fewer capabilities reduces compiled data, not this source download.

The source check follows only allowlisted HTTPS redirects to `download.geofabrik.de` and pins the resolved file URL, size and ETag (or Last-Modified). Catalogs are reused for six hours and file metadata for five minutes. A quote lasts 30 minutes; changing the polygon, routing coverage or source budget requires another check. A changed remote source fails the conditional download rather than silently substituting data. Downloads stream to an owned partial file, enforce the quoted size/budget, and record SHA-256 provenance. Completed sources live in `data/hosted/sources/` and are hash-verified before reuse. They remain there for reuse; there is no cache eviction UI yet.

Osmium first extracts the selection bounding box plus any routing guard, using `smart` with multipolygon/restriction completion. Reference checks precede compilation. The CLI compiles requested display layers, labels, transport modes and indexes into a temporary archive; the existing polygon preparation pipeline then applies the exact selection policy below. The final manifest retains the downloaded source URL/hash and extraction recipe. The importer still holds the cropped source in memory, and native transport import computes all three profiles before retaining selected ones. A small finished file does not imply a similarly small compilation memory footprint.

The Geofabrik path uses **one covering extract**, with a host-chosen source-download budget independent of the output budget. Both budgets have a 1 MiB minimum and accept larger exact values without a 2 GiB cap. A border-spanning selection may require a parent region larger than that budget and will be refused. Automated multi-region merging, user-supplied provider URLs, a locally indexed planet database and full-planet builds are not included. Selections are limited to ±85° latitude, cannot cross the antimeridian, and retain the compiler’s 500,000 candidate-tile limit. The latter is checked before download.

Vienna Plus predates this picker: `scripts/vienna-plus.ts` downloaded the 2026-10-06 Austria, Slovakia and Hungary PBFs (1,483,728,066 bytes total), cropped them with Osmium, merged the crops, and compiled the result. That recipe intentionally handles three regional inputs; the first worldwide UI path does not yet do that merge. Independently generated imports must not be assumed to share a compatible snapshot for federated routing.

## Independent selections

- Map geometry: landscape, water, roads/paths, railways, buildings/heights, mountain geometry.
- Labels: settlements, streets and POIs, independently.
- Routing and isochrones: walking, cycling and driving, independently. Only modes with RCL2 cells in the source are offered. Legacy RTE1/RCL1 walking packages still work in the consumer and existing offline exporter, but are not offered for host transport preparation.
- Location search, reverse geocoding and peak-query data, independently.
- Extractable source geometry: water, buildings, railways, roads and land, independently of display layers.

For installed Atlas sources, only selected payload families are read for preparation. Source identity is also checked by opening and hashing the input file; progress byte counters count reader directory/payload reads, not that filesystem identity pass. Search indexes are still regional JSON blocks: selecting search can read a large parent block to retain a small subset. Improving those indexes remains separate work.

Unselected capabilities are absent from the output, not merely hidden. An enabled category with no retained source objects is omitted from the final feature catalog. Search/peak indexes can be present with zero results. Custom plugins requiring a specific feature family (such as `features/water`) are unavailable when that family is omitted. Consumers default to an available travel mode and disable absent layers/categories.

## Boundary semantics

The manifest stores the selection polygon, parent snapshot and boundary policy:

- Display geometry retains whole intersecting tiles at every selected zoom. Coarse tiles can extend substantially outside the outline. This is tile selection, **not an exact geometry crop or a geographic access-control boundary**.
- Source-feature extraction retains whole intersecting objects, including IDs, tags, multipolygon components and holes. Their full shapes can cross the outline.
- Settlement/POI/search points are retained by position; road labels and reverse-geocoding polylines are clipped to the polygon. Search uses each record’s representative position, so a long named street with its anchor outside the outline can be omitted even if part of it crosses the selection.
- Routing preserves complete RCL2 cells and their node/way IDs and restrictions. Optional padding adds 0–4 neighbouring cells. Requests beyond this selected cell domain report **missing data**, rather than treating omitted cells as disconnected roads. Parent-source completeness is still unknown at the original source boundary. No cross-host fetching/stitching yet.
- Transport statistics sum cell records, which can duplicate nodes/segments across cells; the manifest marks this as `statistics: "cell-records"`.

## Persistence and execution

`packages/provisioning/` plans selected block families and transforms them. `apps/server/preparations.ts` owns jobs; `preparation-worker.ts` is a separate Bun **process**, with IPC progress/cancellation. One preparation runs at a time. PBF import invokes Osmium and the CLI without shell interpolation in owned job workspaces. Cancellation kills the compiler process group, including its native children; disconnecting from the parent server also aborts the worker. The disk writer keeps only directory metadata and one decoded source block at a time; it writes a payload spool, assembles an indexed file, and publishes by atomic rename. Opening the result verifies its header and root directory before it enters the library. Individual directory pages and payload hashes remain verified on read.

Outputs and job records are in ignored `data/hosted/`, keyed by generated UUIDs. Names never become filesystem paths. Output and source budgets use logarithmic sliders plus exact MiB inputs; the slider scale adapts to the server’s free space. There is no fixed 2 GiB budget ceiling. The UI shows actual available/total bytes on the filesystem holding the map library, refreshes while visible, and supports **Refresh space**. It shows a conservative preparation workspace estimate and disables starting a job when the estimate exceeds available space. Before source planning the estimate uses the download cap; after planning it uses the quoted source size. The server always repeats the free-space check when starting a job. Storage values are unknown if inspection fails, never shown as zero. Installed-source preparation requires room for twice the output budget plus 64 MiB because assembly temporarily holds both spool and final file. PBF jobs additionally estimate scratch space as three source-file sizes plus six output budgets (with a 64 MiB minimum budget for this estimate), plus 64 MiB. Raw/intermediate expansion can still exceed that estimate; free space and memory are not reserved. This is an initial capacity check, not a disk reservation. Interrupted jobs become failed on restart and their owned partial files are removed; automatic resumption is not implemented.

Prepared map computation shares the existing engine and plugin registry. A bounded pool holds up to four prepared-map engines; each has the existing per-engine queue and cache budgets. Range responses stream from pinned file descriptors. This is still a single-machine prototype, not a global compute admission controller or public administration service.

## Endpoints

| Endpoint                               | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `GET /admin/preparations`              | Source choices and persistent job states                      |
| `POST /admin/preparations/source-plan` | Inspect a worldwide PBF source and return a bounded quote     |
| `POST /admin/preparations`             | Start a validated selection                                   |
| `POST /admin/preparations/:id/cancel`  | Cancel a running job                                          |
| `POST /admin/preparations/:id/resume` | Resume a stopped cached-source build using checkpoints |
| `POST /admin/preparations/:id/delete` | Delete an inactive dataset, its record and workspace |
| `GET /catalog`                         | Installed source and ready map manifests/URLs                 |
| `GET /maps/:id.atlas`                  | Full download or HTTP byte ranges                             |
| `GET /maps/:id/api/capabilities`       | Actual per-package operation availability                     |
| `POST /maps/:id/api/:operation`        | Same snapshot-pinned invocation contract as `/api/:operation` |
| `/?map=:id`                            | Open the excerpt in the consumer                              |

Administration requires a loopback peer or explicitly configured trusted LAN origin/subnet; writes require same-origin JSON. The existing `/api/*`, `/maps/demo.atlas`, and source host policy remain compatible. The source policy switches and ContextVM MCP endpoint currently apply **only to the configured source package**. Prepared-map operations are exposed through their own HTTP APIs based on retained data. Per-map operation policy, multi-map ContextVM dispatch, Nostr announcements and Hashtree delivery remain deferred; the catalog is local HTTP discovery, not signed federation.

## Verified examples

The local library contains these UI/API-created demonstrations. The two Vienna excerpts share the same parent snapshot:

- **Vienna · water and buildings:** 38,231,093 bytes (36.46 MiB), selected through the world preview. Only water/building display layers; no labels, routing, search or extraction data. Browser checks cover rectangle drawing, refresh during preparation, download, consumer rendering, local-preview switching, polygon undo/finish and mobile layout.
- **Vienna centre · all capabilities:** 33,946,082 bytes (32.37 MiB), `[16.34, 48.195, 16.41, 48.235]`, stored z0–16 and two routing padding cells. Walking/cycling/driving routes and 60/120-second isochrones match between local and server execution. Search and nearest-street results match; source building extraction returns selectable geometry.

- **Monaco · global OSM import:** 20,643 bytes, stored z0–16, from a 691,626-byte Geofabrik PBF dated 2026-10-08. The browser selected a small port area, checked its source, invalidated/rechecked the plan after changing the download budget, prepared it, reloaded the library and opened the map. It retains roads/buildings, labels, location search, nearest-street lookup and source buildings; absent water/land categories are not advertised. No routing was selected.

These sizes describe different areas and capability selections, not a like-for-like compression comparison. The source archive is 823.80 MiB. Generated files and browser screenshots are local demo artifacts, not committed fixtures.

Run `bun test`, `bun run typecheck`, and `bun run build:web`. Automated tests also cover actual PBF cropping/compilation with one travel mode, provider polygon holes, source redirects and size caps, metadata reuse, changed/truncated sources, cache integrity cancellation of compiler subprocesses, arbitrary larger budgets and filesystem capacity reporting. Existing tests cover selected family reads, clipped labels/search, source-object preservation, partial transport profiles, local/server routing, explicit missing coverage, stale/invalid selection rejection, cancellation, persistence and administration checks.

Preview integration follows the [OpenFreeMap quick-start guide](https://openfreemap.org/quick_start/). MapLibre is bundled for the **host preview only**; the Atlas consumer continues to use the Rust/Wasm renderer.

Source acquisition uses the [Geofabrik catalog](https://download.geofabrik.de/index-v1.json) and [Osmium smart extraction](https://docs.osmcode.org/osmium/latest/osmium-extract.html).

Storage UI verification covers exact 8 GiB output / 64 GiB source budgets, slider keyboard controls, empty values, live disk statistics and refresh, quoted-size estimates, insufficient-space rejection in both UI and server, and 390 px mobile layout. This check uses recorded provider metadata; disk reporting and server preflight are live. The earlier Monaco import used the real public PBF. Provider requests can time out independently of disk checks and can be retried without downloading an unquoted source.


## Library lifecycle verification

Provisioning tests build an Atlas child from a prepared parent, reject absent
capabilities and unavailable source IDs, protect active source maps and the base
map, exercise the same-origin deletion endpoint, close warmed serving readers,
verify catalog/file/compute removal, preserve the child and source files, and
recover a deletion interrupted after its persistent tombstone. No existing LAN
map is deleted as part of verification.
