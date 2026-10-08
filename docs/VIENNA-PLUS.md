# Vienna Plus: regional 0–16 package

The prepared package is **725,284,965 bytes (725.3 MB / 691.7 MiB)**, below the **2,000,000,000-byte** output ceiling. It contains stored, nonempty vector tiles at **every zoom from 0 to 16**. Zooms 17–20 overzoom the z16 geometry. Low zooms use the existing layer visibility and geometry simplification rules; “0–16” does not mean all OSM tags or relation types are implemented.

| Content                                       |                                    Count |
| --------------------------------------------- | ---------------------------------------: |
| Retained display features                     |                                2,207,068 |
| Spatial tile addresses                        |                                  118,491 |
| Walking graph nodes                           |                                3,308,492 |
| Walking segments                              |                                3,547,639 |
| Location search records                       |                                  178,580 |
| Reverse-lookup street ways                    |                                  406,630 |
| Peaks                                         |                                    2,880 |
| Street/POI label blocks                       | 2,053 (separate purposes and zoom tiers) |
| Display layer directory pages                 |                                      920 |
| Display layer blocks                          |                                  344,461 |
| Source-geometry blocks                        |                                    1,889 |
| Source-geometry directory pages               |                                       10 |
| Assembled area relations                      |                                   15,043 |
| Skipped incomplete/unsupported area relations |                                      130 |

Every one of the 353,950 stored data blocks and 939 directory pages passed SHA-256 verification. All tile payloads passed structural checks; the largest contains 73,582 features and 471,663 points. All 5,542 RCL1 cells also passed the actual WASM decoder and address check; the largest decoded cell is 455,716 bytes. The full stored-payload audit is repeatable with `scripts/verify-package.ts`.

Stored tiles by zoom: `0:1, 1:1, 2:1, 3:1, 4:1, 5:1, 6:2, 7:2, 8:4, 9:12, 10:37, 11:116, 12:426, 13:1541, 14:5915, 15:22660, 16:87770`.

The current snapshot is `f54574974b952b7d7440e5e6c520e30f589d1345a84d29b613d89cf6153d2f86`. It adds **5,542 routing cells in 9 directory pages**, while retaining the reference graph and all existing payloads. It preserves the earlier fixes to Danube relation 2742635, buildings at z13 and TIL2 height attributes. Across 1,290,229 building/part features, **10,198** have tagged heights, **117,096** use floor-based estimates and **1,162,935** use the renderer fallback. These are OSM objects, not unique physical buildings. The highest retained tag is 970 m; values are community data and may contain outliers.

**1,160 settlement names** now live in the independently requested `labels/places` block: 20,682 stored bytes (76,721 decoded). The initial header and root metadata total **632,623 bytes**. Turning off city/village names before loading fetches zero place-label bytes. Old inline-name packages remain readable but cannot undo their manifest transfer.

## Sources and coverage

The recipe downloads public Geofabrik extracts for **Austria, Slovakia and Hungary**, dated **2026-10-06**. Combined source download size is **1,483,728,066 bytes**. No planet download is needed.

- [Austria](https://download.geofabrik.de/europe/austria.html): `austria-261006.osm.pbf`, 811,818,936 bytes.
- [Slovakia](https://download.geofabrik.de/europe/slovakia.html): `slovakia-261006.osm.pbf`, 345,475,164 bytes.
- [Hungary](https://download.geofabrik.de/europe/hungary.html): `hungary-261006.osm.pbf`, 326,433,966 bytes.

Osmium extracts each input with bounding box **15.55, 47.70, 17.35, 48.65** and `complete_ways`, then merges/deduplicates them. This includes Vienna, St. Pölten, Baden, Wiener Neustadt, Bratislava and northern Burgenland. Completing crossing ways extends some geometry beyond the box; the package bounds describe that retained geometry, not a promise of complete coverage outside the requested box. The source has no missing node references in its ways according to `osmium check-refs`.

Per-input SHA-256 values, dates and extraction parameters are embedded in the manifest. The merged regional PBF digest is `46f2a0658d871ca7c8074b758566a9d7704ff6b7a1bd225e4b11c62dcb15f9b7`.

## Reproduce

```sh
brew install osmium-tool
bun run data:vienna --dry-run
bun run data:vienna
bun run build
bun run start
```

The server chooses Vienna Plus when its package exists, otherwise Liechtenstein. Select either explicitly with `ATLAS_FILE=data/liechtenstein.atlas` or `ATLAS_FILE=data/vienna-plus.atlas`.

To regenerate from the already prepared regional PBF:

```sh
bun run cli generate --input data/vienna-plus.osm.pbf \
  --output data/vienna-plus.atlas --name 'Vienna Plus' \
  --min-zoom 0 --max-zoom 16 --max-bytes 2000000000 --no-source-features --features
bun scripts/verify-package.ts data/vienna-plus.atlas
```

`--no-source-features` omits the redundant full source GeoJSON debug/export block. `--features` adds spatially paged source geometry for selecting and exporting objects, independent of display tiles. This adds about 241.6 MB to the package and only 2.6 KB to its root metadata; payloads are not fetched during ordinary viewing. It does not omit supported display layers, the walking graph, search records, street geometry or peak queries. The CLI compresses each block independently, spools payloads to disk, and atomically publishes only after the total file size passes the budget check. Native import and geojson-vt preprocessing still retain regional data in memory; this is not a planet-scale compiler.

The output ceiling is a maximum, not a target to fill. Compression leaves substantial room below 2 GB without removing zoom levels.

## Draw your offline world

1. Open **Offline**, pan/zoom to an area, then choose **Draw an area**.
2. Click at least three corners and choose **Finish area** in the toolbar over the map, or press **Enter**. Dragging pans; Space adds the center; Undo removes a corner; Escape/Cancel clears the draft.
3. Choose the stored zoom range. The layers and labels selected in Data are included; walking routes, search/street data and peak queries are opt-in.
4. Choose **Build offline file**, then **Save offline file** or **Open this world**.

The device worker or server reads the chosen tile blocks and the needed semantic blocks, verifies hashes, clips the graph and street segments, and writes a new self-contained package. Display tiles are retained whole where they intersect the polygon, so visible geometry can extend beyond it. Routing cannot detour outside the polygon. Cut endpoints get independent synthetic negative IDs; coincident geometry is not turned into a junction. Forward search retains records whose representative point lies inside. Simple concave polygons work; holes, self-intersections and date-line crossings are not supported.

An exported manifest records its polygon, parent snapshot and boundary policy. Feature counts are labelled **Tile records** because geometry repeated across tiles/zooms is not a count of unique OSM features. The source attribution/provenance travels with the file.

The browser demo limits exported files to 256 MB. The source graph and search tables are still single blocks, so drawing a tiny area can require reading larger regional semantic blocks first. The estimate shows source bytes before clipping, not the final file size. Street names and named POIs are included as clipped label blocks regardless of the search-index option. Whole low-zoom tiles also contain surrounding regional data. Tile directories are paged and scoped to the selected area during planning and export. Exact display-vector clipping, cell-aware routing export and paged search indexes remain future work. Offline children currently retain a clipped reference graph and omit the parent routing-cell directory. Offline child packages currently omit the optional source-geometry extraction index; save selected objects separately as GeoJSON.

The service worker saves the app shell (HTML, CSS, JavaScript and WASM). Once **App saved for offline use** appears, the app can reload at the same origin without networking. A separate 128 MiB IndexedDB cache retains viewed map blocks, labels, directories and routing cells; the last validated root can reopen offline. **Cache only** uses that store as well as session memory. Browser eviction or clearing site data removes cached coverage. For a portable offline selection, save and reopen the explicit `.atlas` file. Search, queries and the reference graph are not persisted by the incidental cache.

A central-Vienna browser smoke export retained z0–16 and produced a roughly 44 MB package. Rendering, forward search, nearest-street lookup and walking routing were verified after disabling networking, reloading the shell and reopening the file. A separate visible-browser sweep rendered every zoom from 0 through 20 without missing tiles or browser errors. These sizes vary with the polygon. The Vienna route demo found a 2.06 km Stephansplatz → Praterstern walk; routing is an experimental distance-only walking profile, not navigation guidance.

## Map-only transfer budget

Before layer separation, a visible Chromium test at 1440×1000, default Vienna center, measured `.atlas` range response bytes through z11–17 without panning:

| Measurement                     | Previous |  Current |
| ------------------------------- | -------: | -------: |
| Opening header + root directory | 24.10 MB | 0.515 MB |
| Initial z11 view                | 30.03 MB |  1.75 MB |
| Cumulative through z17          | 53.88 MB |  7.49 MB |

These totals exclude the app shell/WASM and vary with viewport, center and enabled layers. Routing, search and queries were not requested and transferred zero payload bytes. The inspector now separates bytes by purpose. This table describes the earlier combined-tile revision. Measurements from the preceding layer-selective revision are below.

The reductions come from directory paging, half-pixel display simplification at normal zooms, zoom-dependent feature classes, and separate label purposes/visibility tiers. Z0–5 keeps an overview-specific simplification profile so the small regional footprint survives at world scale. Z16 retains unsimplified supported geometry. Native routing and geocoding precision is independent of display simplification.

## Client/server and extraction proof

Snapshot `76caa21e0e42f876c6d0fae41dfd871f6e1dcc5d6947722522102e1194449bb7` was verified in a visible Chromium browser at 1600×1000:

- Server route: 2.06 km, 6.2 KB result, zero client routing bytes. Explicit device comparison matched distance, coordinates and OSM way IDs.
- Forward search, nearest-street lookup and highest-peak query executed on the server with zero client search/query payload bytes. The peak was Klosterwappen, 2,076 m.
- Buildings near Schönbrunn: map-click selection, exact client/server GeoJSON parity, and reuse in cache-only mode with zero new source bytes. Device extraction read 4.18 MB of spatial source blocks for that view.
- Rail extraction returned 72 line objects in the same view. The `water=lake` filter found `way/1003528795` east of central Vienna; exact filters depend on OSM tagging (Alte Donau is tagged `water=oxbow`).
- A small polygon near Stephansplatz exported on the server to a 4.5 MB map-only file, which reopened through the local-file reader. Full z0–16 was retained.
- Capability disabling, selected GeoJSON/polyline downloads, and the five tabs at 390 px mobile width passed without browser errors.

These measurements are viewport/selection-specific, not performance guarantees. API response bytes and package range bytes are shown separately.

## Selective display layers

The earlier layer-conversion snapshot was `59d63b3503c9962dec7e9ee285a64ee35300604114ad98d75096387237197ef0`. The conversion preserved all **118,490 spatial addresses**, all per-tile feature counts and zooms **0–16**, and every non-map payload hash. Source coordinates, polygon rings and holes are copied byte-for-byte. It produces **343,103 display layer blocks**, with 916 display pages and 10 source-geometry pages. The root metadata is **705,596 bytes**.

| Display layer |  Blocks | Stored payload bytes |
| ------------- | ------: | -------------------: |
| Landscape     | 107,251 |           73,254,056 |
| Water         |  57,335 |            9,732,031 |
| Buildings     |  46,831 |           98,151,169 |
| Roads & paths | 110,895 |           53,895,159 |
| Railways      |  13,184 |            3,678,943 |
| Peaks         |   7,607 |              214,488 |

The whole package grows by about **19.3 MB** over combined tiles because independent compression and extra directory entries have overhead. This buys arbitrary selective delivery; it is not a reduction in storage or all-layer request count.

A visible Chromium test configured buildings + water through the checkboxes, reloaded to verify settings apply before any tile request, and zoomed z11–17 without panning at 1600×1000. All 183 HTTP range requests were mapped back to the package directory: only header/root metadata and buildings/water directory pages/payloads were requested. Total **2.64 MB**; buildings **1.50 MB**, water **105.8 KB**, all other geometry/labels/semantic payloads **zero**. Re-enabling cached water generated zero new range requests. Enabling roads generated ten requests, all for road pages/payloads.

A server-built offline file for a small central-Vienna polygon contained only buildings/water tile blocks, with no labels or semantic blocks: **232,350 bytes**, 20 blocks, declared zoom range 0–16. File size varies with selection. Opening it locally, changing layers and disabling all geometry were verified. A layer absent at a particular zoom is empty; buildings began at z14 in that revision and now begin at z13.

The old combined package is retained locally as `data/vienna-plus.combined.atlas`. To convert another existing package:

```sh
bun run cli split-layers --input data/region.atlas --output data/region.layered.atlas
bun scripts/verify-package.ts data/region.layered.atlas data/region.atlas
```

The second audit argument compares original spatial tile counts and non-map hashes. New OSM generation already emits separate layers, so no extra migration step is needed after rebuilding.

## Prototype 008 verification

All 348,408 payloads and 930 directory pages passed integrity and structure checks. Eight direct tile checks (four Danube points, each at z13 and z16) confirm filled water. The central-Vienna z13 building tile has 8,016 footprints, including 2,129 tagged heights and 4,927 floor estimates. This is a tile sample, not a regional coverage percentage. The previous file is retained locally as `data/vienna-plus.pre-heights.atlas`.

Visible Chromium checks verified: cold settlement-name bytes remain zero when disabled; enabling them reads 20.7 KB; footprints draw at z13; right-drag, Command-drag and Command-wheel change pitch/bearing; Top-down and R reset the view; scene preferences persist; tilted picking matches an independent inverse projection; offline polygons finish; no horizontal overflow at 390 px. A second styling check recorded zero additional map requests and zero `bufferData` uploads for paint/shading edits. Browser wheel deltas may be scaled by the platform; a real physical trackpad was not operated by this automation.
