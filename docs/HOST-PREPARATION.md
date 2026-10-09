# Host preparation demo

Implemented 2026-10-09. Open `http://127.0.0.1:3100/host` after `bun start`.

## Try it

1. The default **OpenFreeMap · world** preview is served by OpenFreeMap using MapLibre, with attribution. The blue dashed outline is the installed source’s bounding box. **Fit source** returns to it. **Local Atlas · source** uses our own renderer and range-served archive instead; it does not need the external basemap.
2. Choose **Rectangle** and click two opposite corners, or **Polygon**, click corners, then **Finish polygon**. Enter also finishes a polygon; Undo removes a corner; Escape stops drawing. Space adds the map center when the map is focused. **Use visible area** selects the view clipped to source bounds.
3. Give the map a name, choose stored zoom levels, and choose its data. **Just view the map**, **Water & buildings only**, and **Everything available** are starting presets; every selection can be customized.
4. **Prepare & host map** starts a background process. The progress view reports its current phase, blocks processed and archive bytes read/written. You can refresh or leave the page; the server owns the job. Cancel removes incomplete output.
5. The library offers **Open map**, **Download .atlas**, and **Capabilities**. Each excerpt is a separate immutable snapshot with its own HTTP range URL and operations endpoint. Completed jobs and files survive server restarts.

A world preview does **not** supply worldwide Atlas data. This slice prepares from the configured installed source (`ATLAS_FILE`, otherwise Vienna Plus / Liechtenstein). Corners must lie within that source’s bounds. Remote source discovery/download, PBF import through the UI, and the optional coarse-world archive are future work. Local preview still needs this host’s running server; it is independent of OpenFreeMap, not a separately installed offline app.

## Independent selections

- Map geometry: landscape, water, roads/paths, railways, buildings/heights, mountain geometry.
- Labels: settlements, streets and POIs, independently.
- Routing and isochrones: walking, cycling and driving, independently. Only modes with RCL2 cells in the source are offered. Legacy RTE1/RCL1 walking packages still work in the consumer and existing offline exporter, but are not offered for host transport preparation.
- Location search, reverse geocoding and peak-query data, independently.
- Extractable source geometry: water, buildings, railways, roads and land, independently of display layers.

Only selected payload families are read for preparation. Source identity is also checked by opening and hashing the input file; progress byte counters count reader directory/payload reads, not that filesystem identity pass. Search indexes are still regional JSON blocks: selecting search can read a large parent block to retain a small subset. Improving those indexes remains separate work.

Unselected capabilities are absent from the output, not merely hidden. An enabled category with no retained source objects is omitted from the final feature catalog. Search/peak indexes can be present with zero results. Custom plugins requiring a specific feature family (such as `features/water`) are unavailable when that family is omitted. Consumers default to an available travel mode and disable absent layers/categories.

## Boundary semantics

The manifest stores the selection polygon, parent snapshot and boundary policy:

- Display geometry retains whole intersecting tiles at every selected zoom. Coarse tiles can extend substantially outside the outline. This is tile selection, **not an exact geometry crop or a geographic access-control boundary**.
- Source-feature extraction retains whole intersecting objects, including IDs, tags, multipolygon components and holes. Their full shapes can cross the outline.
- Settlement/POI/search points are retained by position; road labels and reverse-geocoding polylines are clipped to the polygon. Search uses each record’s representative position, so a long named street with its anchor outside the outline can be omitted even if part of it crosses the selection.
- Routing preserves complete RCL2 cells and their node/way IDs and restrictions. Optional padding adds 0–4 neighbouring cells. Requests beyond this selected cell domain report **missing data**, rather than treating omitted cells as disconnected roads. Parent-source completeness is still unknown at the original source boundary. No cross-host fetching/stitching yet.
- Transport statistics sum cell records, which can duplicate nodes/segments across cells; the manifest marks this as `statistics: "cell-records"`.

## Persistence and execution

`packages/provisioning/` plans selected block families and transforms them. `apps/server/preparations.ts` owns jobs; `preparation-worker.ts` is a separate Bun **process**, with IPC progress/cancellation. One preparation runs at a time. The disk writer keeps only directory metadata and one decoded source block at a time; it writes a payload spool, assembles an indexed file, and publishes by atomic rename. Opening the result verifies its header and root directory before it enters the library. Individual directory pages and payload hashes remain verified on read.

Outputs and job records are in ignored `data/hosted/`, keyed by generated UUIDs. Names never become filesystem paths. The output budget is 1–2048 MiB. Starting requires room for twice the output budget plus 64 MiB because assembly temporarily holds both spool and final file. This is an initial capacity check, not a disk reservation. Interrupted jobs become failed on restart and their owned partial files are removed; automatic resumption is not implemented.

Prepared map computation shares the existing engine and plugin registry. A bounded pool holds up to four prepared-map engines; each has the existing per-engine queue and cache budgets. Range responses stream from pinned file descriptors. This is still a single-machine prototype, not a global compute admission controller or public administration service.

## Endpoints

| Endpoint                              | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `GET /admin/preparations`             | Source choices and persistent job states                      |
| `POST /admin/preparations`            | Start a validated selection                                   |
| `POST /admin/preparations/:id/cancel` | Cancel a running job                                          |
| `GET /catalog`                        | Installed source and ready map manifests/URLs                 |
| `GET /maps/:id.atlas`                 | Full download or HTTP byte ranges                             |
| `GET /maps/:id/api/capabilities`      | Actual per-package operation availability                     |
| `POST /maps/:id/api/:operation`       | Same snapshot-pinned invocation contract as `/api/:operation` |
| `/?map=:id`                           | Open the excerpt in the consumer                              |

Administration requires a loopback peer and hostname; writes require same-origin JSON. The existing `/api/*`, `/maps/demo.atlas`, and source host policy remain compatible. The source policy switches and ContextVM MCP endpoint currently apply **only to the configured source package**. Prepared-map operations are exposed through their own HTTP APIs based on retained data. Per-map operation policy, multi-map ContextVM dispatch, Nostr announcements and Hashtree delivery remain deferred; the catalog is local HTTP discovery, not signed federation.

## Verified examples

The local library contains two UI/API-created demonstrations from the same Vienna Plus snapshot:

- **Vienna · water and buildings:** 38,231,093 bytes (36.46 MiB), selected through the world preview. Only water/building display layers; no labels, routing, search or extraction data. Browser checks cover rectangle drawing, refresh during preparation, download, consumer rendering, local-preview switching, polygon undo/finish and mobile layout.
- **Vienna centre · all capabilities:** 33,946,082 bytes (32.37 MiB), `[16.34, 48.195, 16.41, 48.235]`, stored z0–16 and two routing padding cells. Walking/cycling/driving routes and 60/120-second isochrones match between local and server execution. Search and nearest-street results match; source building extraction returns selectable geometry.

These sizes describe different areas and capability selections, not a like-for-like compression comparison. The source archive is 823.80 MiB. Generated files and browser screenshots are local demo artifacts, not committed fixtures.

Run `bun test`, `bun run typecheck`, and `bun run build:web`. Automated tests cover selected family reads, clipped labels/search, source-object preservation, partial transport profiles, local/server routing, explicit missing coverage, stale/invalid selection rejection, cancellation, persistence and administration checks.

Preview integration follows the [OpenFreeMap quick-start guide](https://openfreemap.org/quick_start/). MapLibre is bundled for the **host preview only**; the Atlas consumer continues to use the Rust/Wasm renderer.
