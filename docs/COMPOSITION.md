# Composition demo

Open `/` → **Client composer**, or select prepared maps in `/host` → **Your map library** → **Compose selected maps**. The optional source package remains listed but is not selected by default when prepared maps exist. **Go to map** focuses one source; **Fit selected** frames the union. Disjoint excerpts leave blank space between them.

Each card controls geometry layers and labels independently. Disabled sources are disposed, aborting in-flight reads and dropping their GPU meshes. Toggle one back on to reuse validated blocks in the shared persistent cache. Arrow buttons raise display priority. Coverage outlines show original advertised polygons; the actual visible coverage may be smaller after priority resolution. These controls change the consumer's subscription, not the files hosted on disk.

**Copy view link** includes catalog URLs, selected sources, layer choices, order, tool source and camera. Recipients must be able to access those hosts; a localhost link remains local to its machine. New view links pin the Hashtree root. If a host replaces that revision, the client reports it as unavailable instead of silently selecting different data.

## Discovery and delivery

The normal network composer uses signed Nostr announcements and Hashtree reads.
Connecting a host loads its `/discovery` bootstrap (publisher, relay and signed
events), verifies the events, then subscribes to its relay. The former HTTP catalog
form and per-map HTTP/Hashtree selector have been removed. A host automatically
indexes each newly completed served file; publication progress is under Discovery
& delivery. Failed indexing can be retried there. `ATLAS_PUBLIC_URL` controls the
advertised LAN/public origin; `ATLAS_DISCOVERY_AUTO=0` disables automatic indexing.

`GET /catalog` and `/maps/<id>.atlas` remain interoperable metadata/download APIs.
They are not an alternate composition transport in the UI. Local `.atlas` files
still open directly, including the combined archives below. See [Hashtree](HASHTREE.md)
for signature verification, mirrors and caching.

## Pack a composition into one file

Select maps under **Your map library**, enter a **Combined file name**, then click
**Pack selected maps into one .atlas**. This queues a durable job with progress.
It copies the complete selected archives, including routing, geometry, search,
feature extraction, raster tiles and opaque custom blocks. The resulting file
works after its input archives are removed. Live composition requires no export;
packing makes that collection portable as a single self-contained file.

The outer manifest has `map-composition` and a versioned member directory. Every
member retains its original bytes, manifest, graph identity, indexes and hashes.
Member data is stored in hashed 1 MiB chunks with a paged directory; readers expose
ordinary Atlas byte ranges over those chunks. This avoids conflating unrelated
OSM IDs, custom schemas or graph identities. The extra chunk layer can overfetch
up to 1 MiB for small cold reads; optimize that after measuring real large exports.
Hashtree's 64 KiB leaves are a separate transport layer.

The viewer expands members into the normal compositor, with per-layer display
ownership and scoped tools. HTTP server tools use
`/maps/<bundle-id>/api/members/<member-id>/<operation>`. Cross-member routing still
requires the same OSM authority revision and routing contract for RCL3, or the
same compiled graph for legacy RCL2. Packaging alone cannot establish compatibility. A local file runs its tools on the device.

This slice packs whole selected maps (1–64 members); it does not clip a composition
to a new polygon, deduplicate overlapping archives, or recursively nest bundles.
Input revisions are pinned and protected from deletion while queued/running. All
stored blocks are checked before copying; publication is exclusive and atomic.
Packing retries restart the copy, while original inputs remain intact. Allow
roughly twice the combined input size as temporary/final workspace.

The regional preparation API also accepts explicit raster layer IDs and retains
intersecting raster tiles with their original bytes and attribution. It does not
mask edge pixels. That existing single-map excerpt path only understands supported
families; use whole-member packaging to preserve unknown custom data unchanged.

## Display ownership

The first enabled source owns each selected layer inside its polygon. A higher source offering only water and buildings does not hide roads, land or railways from a lower source. Labels use their own coverage channel. Disabling a channel releases that coverage to the next source. A source below its minimum zoom claims nothing; beyond its maximum stored zoom it overzooms through view zoom 20.

`composition-plan.ts` subtracts higher-priority polygons per channel in normalized Mercator coordinates, retaining holes and disconnected pieces. `CoveredTiles` skips payloads for cells entirely outside the resulting coverage. Partial cells remain whole immutable blocks. The Rust renderer uses stencil masks to clip those cells precisely, drawing layers from all sources in the normal global layer order. There is one WebGL context and one camera. Label boxes must fit within their owning coverage; placement shares a collision list across sources.

An empty authoritative tile is empty coverage, not permission to mix in a lower source. A transport failure is reported on the source card; this slice does not automatically fail over to a different dataset. Existing per-source zoom transition fallbacks remain active during tile loading.

## Scope and budgets

The normal workspace is now a **2D display composition**, including camera rotation/tilt of the ground plane. Existing Route and isochrone controls run across compatible selected sources in a Web Worker. **Tool source** explicitly scopes search, reverse lookup, peak queries, feature extraction, offline export and server tools to one selected map. Extracted features remain selectable on the composed map. Those operations do not silently merge indexes. Building extrusion across clipped boundaries and polygon-clipped composition export are not implemented. Whole-map packaging is available in the host library. No search index or routing graph is fetched merely to display the map.

The composer lives in a normal sidebar tab, opened from **Client composer** in the header. `/compose` bookmarks redirect to `/`, preserving the selection query and shared-view fragment. The **Data** tab filters layers and individual label categories globally; each composer card further restricts its own source. Style dials, map picks, route/isochrone overlays, feature selection and polygon drawing share the same tool interface in both viewers. Byte and memory counters aggregate active sources.

Independent snapshots can compose visually without sharing graph identities. Cross-package routing supports independently compiled RCL3 extracts of the same upstream OSM PBF revision and routing contract. Legacy RCL2 excerpts still require `transport.graphSnapshot` from one compiled graph. A shared date alone is insufficient. `RoutingComposition` selects complete covering cells, verifies overlap hashes and reports unavailable coverage as missing data. See [OSM routing federation](ROUTING-FEDERATION.md) for the contract, evidence and mixed-revision limitations. Signed Nostr announcements and Hashtree mirrors provide discovery and delivery. ContextVM tools retain explicit member/source scope.

Up to eight selected offers are allowed in this UI; a combined offer expands into its retained members. Per-source cache targets are 12 MiB GPU meshes, 8 MiB decoded geometry, 2 MiB decoded labels, 2 MiB parsed label data and 2 MiB directory descriptors. Active meshes can exceed the cache target while pinned. Persistent compressed blocks share the existing 128 MiB cache. Other allocations, directory roots, in-flight reads, places and GPU overhead are additional. The header’s **Purge caches** button and cross-tab purge signal release every source and pause the workspace. **Reopen map** restores the selected composition.

Legacy combined-layer archives need regeneration/splitting before this demo can compose them. Polygon excerpts follow the existing non-antimeridian preparation constraints.

## Verification

On 29 October, the complete Bun suite passed (351 tests); a subsequent integration
test also verified a persisted automatic retry dispatching and completing work. A visible browser check
packed two real Liechtenstein archives (vector/tools plus satellite imagery),
loaded both members over Hashtree with zero `.atlas` HTTP range requests, and
opened the resulting file with its host blocked. Member-specific server tools, saved raster opacity and mobile layout were checked.
With the map host blocked, the packed local file completed nearest-street lookup
and a walking isochrone, then reopened successfully after cache purge. Unit tests verify byte identity, custom data retention,
routing without the originals, input deletion protection and raster excerpt bytes.

Earlier composition checks:

- Bun tests cover priority by channel, polygon holes, triangular coverage, disabled/below-minimum sources, overzoom, hidden tile filtering, identical keys in different snapshots and catalog URL validation.
- Native Rust tests verify triangulated masks preserve holes, separate polygons and small-coordinate precision.
- Visible browser checks used the actual overlapping Vienna excerpts, then Monaco. A temporary second loopback host served a real Atlas file with cross-origin catalog/range access. Checks covered subscription removal across zoom changes, priority, shared-link reload, styles, the original viewer, host-library selection and a 390 px layout.
- The observed Vienna centre plus surrounding water/buildings view read approximately 2.8 MiB at z14.2 including labels in a fresh browser. This is an observation for that viewport, not a global bandwidth guarantee.

## Client routing

**Route** uses the normal map picks and search-result endpoints, travel mode and client search-state limit. **Try Vienna → Bratislava** supplies the demo endpoints when those places are covered. Routing cells are requested only when running a route or isochrone; displaying geometry does not fetch them. The result shows each source’s cell contribution. The worker uses the same Rust/WASM kernel as single-map routing and does not call server route APIs.

The selectable limits are 250,000, 1 million and 2 million states (the composition default); single-map defaults remain 250,000. Cell residency has a separate, configurable 96 MiB budget. Routing uses bidirectional A* and merges equivalent states at unrestricted nodes; the state limit counts both search fronts together. Larger state limits can consume hundreds of MiB; these are bounded prototype searches, not a planet-scale hierarchical router. Cancellation terminates the worker. Source changes discard the graph session. **Cache only** applies to every selected source for both rendering and tools. It prevents network reads and reports missing cached coverage. Cross-source server routing is deliberately unavailable; select **This device** for composed transport operations, or open one map alone for server route comparisons.

Tests exercise all three modes across actual cell boundaries, immutable shared cells, nested provenance, incompatible graphs, conflicts and cached replay.

## Larger shared-source preparation

`bun scripts/danube-composition.ts --dry-run` prints the four-region recipe. Running without the flag uses the pinned Austria, Slovakia and Hungary PBFs already in `data/sources/`. It verifies their checksums, extracts and merges one source, compiles its graph once, then generates geometry packages sequentially with `--transport-from`. Whole graph cells are copied unchanged. This avoids holding a complete multi-gigabyte display archive plus four finished excerpts on disk.

The recipe targets approximately 1 GiB per region, with a 2 GiB safety ceiling; actual content determines the size. Every region requests z0–16, all supported geometry and feature classes, labels, search, reverse lookup, peak queries and walking/cycling/driving. Adjacent regions overlap and retain two padding cells. This is all data supported by the current compiler, not every OSM tag or relation. Only the three input countries are covered; parts of bounding rectangles falling in neighbouring countries lack those countries’ data.

The script checks free disk space before expensive stages and resumes completed stages from `data/danube-build/`. It writes publication records only when all four packages are ready. Keep that directory’s recipe and source provenance together; changing geography or capabilities requires a new build directory (the byte ceiling can change on resume). Generated maps and build outputs are ignored by Git.

## Historical Danube measurements (2026-10-06 source snapshot)

| Archive                          |      Size | Stored detail                     |
| -------------------------------- | --------: | --------------------------------- |
| Vienna & Lower Austria           | 1.124 GiB | z0–16, all supported capabilities |
| Bratislava & western Slovakia    | 1.031 GiB | z0–16, all supported capabilities |
| Graz & southern Austria          | 1.639 GiB | z0–16, all supported capabilities |
| Győr, Budapest & western Hungary | 0.972 GiB | z0–16, all supported capabilities |

Total: **4.767 GiB**. Exact sizes and IDs are recorded in ignored `data/danube-composition.json`. The target is useful regional coverage around 1 GiB, not byte padding or dropping capabilities to force equal sizes. All six previous prepared/demo excerpts were removed; the original Vienna Plus source package remains available but unselected.

`bun run verify:composition` checks repeated cell hashes and actual cross-package routes. The prepared files passed **15,792 overlapping cell comparisons** and Vienna–Bratislava routing in walking, cycling and driving profiles. Driving returned 112.255 km, cycling 65.678 km, walking 62.680 km under the prototype policies. These are experimental engine results, not independently verified navigation recommendations.

The normal `/` workspace browser check found the driving route using cells from all four files and about 16.36 MiB of routing payload after the bidirectional-search update. Cache-only replay used 1,366 cached cells, zero additional `.atlas` requests and no server route API calls. Main-thread controls remained available while computation ran in a worker. These figures describe this example and cache state, not a general transfer or latency guarantee.

Workspace integration checks also exercised scoped search, 200 selectable building features, completing an offline polygon, a 5-minute walking isochrone (1,063 reachable directed segments), cancellation, deselect/reselect, cache purge/reopen, legacy links, the 390 px layout and single-source 3D availability. Query permissions and incompatible graph rejection have automated regression tests.
