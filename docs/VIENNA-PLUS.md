# Vienna Plus: regional 0–16 package

The prepared package is **600,341,628 bytes (600.3 MB / 572.5 MiB)**, below the **2,000,000,000-byte** output ceiling. It contains stored, nonempty vector tiles at **every zoom from 0 to 16**. Zooms 17–20 overzoom the z16 geometry. Low zooms use the existing layer visibility and geometry simplification rules; “0–16” does not mean all OSM tags or relation types are implemented.

| Content                                       |                                    Count |
| --------------------------------------------- | ---------------------------------------: |
| Retained display features                     |                                2,207,067 |
| Vector tiles                                  |                                  118,490 |
| Walking graph nodes                           |                                3,308,492 |
| Walking segments                              |                                3,547,639 |
| Location search records                       |                                  178,580 |
| Reverse-lookup street ways                    |                                  406,630 |
| Peaks                                         |                                    2,880 |
| Street/POI label blocks                       | 2,053 (separate purposes and zoom tiers) |
| Tile-directory pages                          |                                      188 |
| Source-geometry blocks                        |                                    1,889 |
| Source-geometry directory pages               |                                       10 |
| Assembled area relations                      |                                   15,042 |
| Skipped incomplete/unsupported area relations |                                      131 |

Every one of the 122,436 stored data blocks and 198 directory pages passed SHA-256 verification. All tile payloads passed structural checks; the largest contains 81,346 features and 496,518 points. The full audit is repeatable with `scripts/verify-package.ts`.

Stored tiles by zoom: `0:1, 1:1, 2:1, 3:1, 4:1, 5:1, 6:2, 7:2, 8:4, 9:12, 10:37, 11:116, 12:426, 13:1540, 14:5915, 15:22660, 16:87770`.

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
3. Choose the stored zoom range. Map geometry and labels are included by default; walking routes, search/street data and peak queries are opt-in.
4. Choose **Build offline file**, then **Save offline file** or **Open this world**.

The device worker or server reads the chosen tile blocks and the needed semantic blocks, verifies hashes, clips the graph and street segments, and writes a new self-contained package. Display tiles are retained whole where they intersect the polygon, so visible geometry can extend beyond it. Routing cannot detour outside the polygon. Cut endpoints get independent synthetic negative IDs; coincident geometry is not turned into a junction. Forward search retains records whose representative point lies inside. Simple concave polygons work; holes, self-intersections and date-line crossings are not supported.

An exported manifest records its polygon, parent snapshot and boundary policy. Feature counts are labelled **Tile records** because geometry repeated across tiles/zooms is not a count of unique OSM features. The source attribution/provenance travels with the file.

The browser demo limits exported files to 256 MB. The source graph and search tables are still single blocks, so drawing a tiny area can require reading larger regional semantic blocks first. The estimate shows source bytes before clipping, not the final file size. Street names and named POIs are included as clipped label blocks regardless of the search-index option. Whole low-zoom tiles also contain surrounding regional data. Tile directories are paged and scoped to the selected area during planning and export. Exact vector clipping and paged graph/search indexes remain future work. Offline child packages currently omit the optional source-geometry extraction index; save selected objects separately as GeoJSON.

The service worker saves only the app shell (HTML, CSS, JavaScript and WASM). Once **App saved for offline use** appears, the app can reload at the same origin without networking. Reopen a saved `.atlas` file; packages are not silently downloaded or persisted by the service worker. Browser storage eviction or clearing site data removes the saved app shell. **Cache only** remains a separate session-memory experiment.

A central-Vienna browser smoke export retained z0–16 and produced a roughly 44 MB package. Rendering, forward search, nearest-street lookup and walking routing were verified after disabling networking, reloading the shell and reopening the file. A separate visible-browser sweep rendered every zoom from 0 through 20 without missing tiles or browser errors. These sizes vary with the polygon. The Vienna route demo found a 2.06 km Stephansplatz → Praterstern walk; routing is an experimental distance-only walking profile, not navigation guidance.

## Map-only transfer budget

A visible Chromium test at 1440×1000, default Vienna center, measured `.atlas` range response bytes through z11–17 without panning:

| Measurement                     | Previous |  Current |
| ------------------------------- | -------: | -------: |
| Opening header + root directory | 24.10 MB | 0.515 MB |
| Initial z11 view                | 30.03 MB |  1.75 MB |
| Cumulative through z17          | 53.88 MB |  7.49 MB |

These totals exclude the app shell/WASM and vary with viewport, center and enabled layers. Routing, search and queries were not requested and transferred zero payload bytes. The inspector now separates bytes by purpose. Street and POI toggles suppress future requests for their respective label blocks; geometry-layer toggles still control drawing within shared base tiles.

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
