# Shared map operations and selectable geometry

The demo separates **what data to allow** from **where to compute**. Data settings allow routing, search/geocoding, peak queries and feature extraction independently. Enabling a capability does not preload it. Disabling it blocks future tool use and uncached payload reads; it does not erase previously cached bytes or cancel requests already sent.

The five sidebar tabs organize Explore, Route, Extract, Offline and Data. The global **Run tools on** selector chooses this device or the server. Local `.atlas` files use this device; they are not uploaded.

## Execution boundary

`packages/operations` owns `AtlasEngine`, which uses the same reader and algorithms in either host:

| Operation         | Shared implementation                               | Server response                                         |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Walking route     | `AtlasRouter` and compiled Rust/WASM routing kernel | Route geometry, distance, snapped endpoints and way IDs |
| Location search   | `AtlasGeocoder.search`                              | Ranked matching records                                 |
| Nearest street    | `AtlasGeocoder.reverse`                             | Closest street segment and distance                     |
| Highest peak      | `AtlasReader.highestPeak`                           | Maximum known elevation and coverage counts             |
| Object extraction | `AtlasFeatures.query`                               | Source GeoJSON objects                                  |
| Offline package   | `packages/offline.extract`                          | New `.atlas` file                                       |

The browser initializes WASM from its bundled URL; Bun initializes the identical WASM binary from disk. The server uses a `FileSource` over the same pinned package Blob served by HTTP ranges. Map rendering remains in the browser. Server rasterization, driving directions and arbitrary Overpass-like queries are not implemented.

Device mode fetches the required source blocks and retains them for this session. Server mode computes against server caches and returns the result. There is no silent fallback between modes. Cache only blocks server operations. Reopening a local file disables server mode.

## HTTP contract

All operations use `POST /api/<operation>` with JSON `{snapshot, input}`. Use the snapshot from the open package manifest. A mismatched snapshot returns 409; a malformed request returns 400, an unavailable/failed operation 422, and a full operation queue 429. The demo bounds the request body to 16 KiB and serializes work behind an eight-request queue. This loopback prototype has no production authentication, tenant isolation or worker-pool scheduling.

Example route request:

```json
{
  "snapshot": "<manifest.snapshot>",
  "input": {
    "start": [16.3731, 48.2085],
    "end": [16.3918, 48.2194]
  }
}
```

Inputs by endpoint:

| Endpoint        | `input`                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `/api/route`    | `{start: [lon,lat], end: [lon,lat]}`                                                                       |
| `/api/search`   | `{query: "Stephansplatz", limit: 10}`                                                                      |
| `/api/reverse`  | `{point: [16.3731,48.2085]}`                                                                               |
| `/api/peak`     | `{}`                                                                                                       |
| `/api/features` | `{kind: "buildings", bounds: [west,south,east,north], limit: 200, tag: "building=apartments"}`             |
| `/api/offline`  | `{name, polygon: [[lon,lat],...], minZoom: 0, maxZoom: 16, routing: false, search: false, queries: false}` |

JSON responses wrap `{result, execution}`. Execution records side, operation, elapsed computation time and uncached source bytes read on that host. `RemoteOperations` measures actual response body bytes in the browser. Time includes source acquisition/decoding when cold and excludes queue wait and network latency. The inspector shows **API responses** separately from **package bytes**; server source reads are not browser downloads.

Every successful response includes `X-Atlas-Snapshot`. JSON results also include the snapshot, and the client checks both. Offline export returns the binary file with `X-Atlas-Compute-Ms` and `X-Atlas-Source-Bytes`; its response snapshot is the parent, while the exported file contains its own new snapshot and parent reference. Export planning in the UI still reads selected display-directory pages to show the estimate.

## Extract and select

Generate source geometry with `bun run cli generate ... --features`. The Vienna recipe enables this flag. It can be combined with `--no-source-features`, which omits the old monolithic GeoJSON debug block.

1. Zoom into an area and open **Extract**.
2. Choose Buildings, Lakes & water, Rail lines, Roads & paths or Landscape areas.
3. Optionally set one exact OSM tag filter, such as `railway=tram` or `water=lake`.
4. **Extract current view** adds the matching objects as blue outlines.
5. Click shapes or list entries to toggle selection; selected objects turn orange. Tags appear below the list.
6. Download selected GeoJSON, or download polygon boundaries as polylines. Both retain original OSM identities and attribution.

Extraction returns full retained source shapes, including multipolygons and courtyard holes. It does not reverse-engineer display tiles. Shapes crossing the viewport remain complete; line objects correspond to OSM ways rather than assembled route relations. The prototype supports one extraction overlay at a time and at most 500 results, with explicit truncation. Zoom in when the viewport exceeds 0.25° in either direction. Filters use actual tags: Alte Donau is tagged `water=oxbow`, so `water=lake` intentionally excludes it.

Source geometry is paged by category and fixed z12 cells, independently of display zoom. Querying on the device loads intersecting cells, then deduplicates full objects. Server querying sends only result GeoJSON. Water/rail/building display switches still hide geometry within shared base tiles; they do not split those display payloads. Street-name and POI labels do have separate payloads. Offline child `.atlas` exports currently omit the extraction index; selected objects can be saved separately as GeoJSON.

## Proof and validation

`tests/operations.test.ts` starts a real Bun HTTP server around the shared engine. It checks client/server equality for routing, search, reverse lookup, peak queries and extraction, plus binary offline export, snapshot rejection and invalid inputs. The source-geometry fixture covers multi-cell duplication, exact tags, polygon holes, cache-only reuse and polygon-to-line conversion.

Visible Chromium verification against the Vienna package found:

- Stephansplatz → Praterstern: **2.06 km**, **6.2 KB** server response, **zero** browser routing-block bytes.
- The explicit comparison then read the **69.45 MB** compressed walking graph on the device and matched route coordinates, distance and OSM way sequence exactly.
- Building selection by map click; client/server feature GeoJSON equality; cached extraction without new source reads; GeoJSON and polyline downloads.
- Server search, reverse lookup, peak query, railway extraction, exact lake tag filtering and offline export.
- Optional capability disabling, local-file mode, and tab layout at desktop and 390 px mobile width.

The package audit verified every stored block and directory page. Source/runtime caches and importer memory are still regional prototypes. These results establish correctness for the tested cases, not planet-scale memory or throughput guarantees.
