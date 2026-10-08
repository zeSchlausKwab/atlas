# Atlas / geo-format

An end-to-end map stack experiment: OSM PBF → a single `.atlas` package → byte-range delivery → Rust/WASM vector rendering, walking routes and location search on the client or server in a Bun web app.

This is a working prototype, not a finalized format or a MapLibre compatibility implementation. No MapLibre, remote basemap tiles, commercial map API, or planet download is used.

## Run it

Prerequisites: Bun, Rust/Cargo, `wasm-pack`, and the `wasm32-unknown-unknown` Rust target.

```sh
bun install
rustup target add wasm32-unknown-unknown
bun run setup
bun run dev
```

Open **http://127.0.0.1:3100**. `setup` downloads a dated ~3.3 MiB Liechtenstein PBF, builds a native Rust importer, generates the package, and builds the WASM and web artifacts. First compilation downloads Cargo dependencies and may build wasm-bindgen tooling. Nothing is published externally.

For an already prepared checkout:

```sh
bun run dev
```

The server watches TypeScript changes and rebuilds the frontend on restart. Refresh the browser after changes. Rust renderer or routing changes require `bun run build:wasm`. Server restart is required to load a regenerated map package. `PORT`, `HOST`, and `ATLAS_FILE` override the defaults; the host defaults to loopback.

## Vienna Plus and offline drawing

**Vienna Plus is ready: 640.1 MB, 118,491 spatial tile addresses across every zoom from 0 through 16**, with walking routing, location search, street geometry, peaks and optional selectable source geometry. The recipe combines public Austria/Slovakia/Hungary extracts (1.48 GB total source download) and enforces a 2 GB final-package ceiling. No zoom levels are dropped to fit the budget. See [coverage, exact counts and reproduction recipe](docs/VIENNA-PLUS.md).

```sh
bun run data:vienna # needs osmium-tool, uses verified cached sources when present
bun run build
bun run start
```

The server prefers Vienna Plus when present. **Draw your offline world** selects a polygon and creates a smaller `.atlas` file on this device or the server, with clipped routing/search and complete intersecting display tiles. Save it, reload the cached app shell offline and open the file. [Boundary semantics and offline instructions](docs/VIENNA-PLUS.md#draw-your-offline-world).

## Four components

| Component         | Location                               | Responsibility                                                                                                                           |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering library | `crates/renderer`, `packages/renderer` | Rust/WASM tile decoding, polygon tessellation and WebGL2 GPU rendering; TypeScript camera, input, tile scheduling, and overlays          |
| Generation CLI    | `packages/cli`, `crates/osm-import`    | Download and fingerprint source data; import selected OSM features; produce binary vector tiles, query/search blocks and a walking graph |
| Format + reader   | `packages/format`, `docs/FORMAT.md`    | Experimental single-file layout, block directory, SHA-256 checks, local-file and HTTP readers                                            |
| Delivery server   | `apps/server`                          | Bun HTTP server, byte ranges, strong ETags, pinned map operations and browser assets                                                     |

`crates/routing` contains the shared native/WASM graph codec, snapping and shortest-path engine; `packages/routing` connects it to the package reader. See [routing design and profile](docs/ROUTING.md). `packages/geocoding` compiles and reads named-location and street indexes for local forward/reverse lookup; see [geocoding design](docs/GEOCODING.md).

`apps/web` is an instrumented demo using those components. Roads, landcover, water, buildings, railways, paths, and peak markers are rendered by the WASM library. Place labels, the scale bar, grid, search/nearest-street highlights, route line/endpoint markers, and selected-peak overlay currently use a separate Canvas2D overlay.

## Try the demo

The wider sidebar has **Explore**, **Route**, **Extract**, **Offline**, **Style**, and **Data** tabs. **Run tools on** switches between this device and the server for routing, forward/reverse geocoding, peak queries, feature extraction and offline export. Local files use this device. The Data tab enables each optional capability without preloading its data.

**Extract** adds buildings, water, railways, roads or landscape areas from the current view as a selectable overlay. Click shapes or list entries, inspect their OSM tags, then download the selection as GeoJSON or polylines. Full source shapes and courtyard holes are preserved. Use an optional exact tag filter such as `water=lake`, `water=oxbow` or `railway=tram`. Source geometry loads only when requested.

**Compare device & server** checks route distance, coordinates and OSM way sequence against the same snapshot. The Vienna example returned a **6.2 KB** server response and zero browser routing-block bytes; explicit device comparison then loaded the **69.45 MB** graph and matched exactly. See [server operations and extraction](docs/SERVER-AND-EXTRACTION.md) for the API, data boundaries and verification.

The following local-data experiments assume **Run tools on → This device**:

- **City & village names** have an independent checkbox and data block; disabling them before loading avoids the name payload.
- **Street names** appear from z13 (major roads), with local streets from z15. **Points of interest** appear progressively from z14–17. Toggle each layer independently; click a POI marker or name to inspect it and use it as a route endpoint. Labels load from nearby package cells, independently of the geocoder. They remain in offline exports even when the separate search option is off.
- The missing buildings near Schönbrunn were an importer omission: relation-based building outlines never reached the tile compiler. See the [diagnosis and fix](docs/BUILDINGS-AND-LABELS.md).

- Drag or use arrow keys to pan. Scroll, use +/−, or use the buttons to zoom **up to 20**. Above the package’s highest stored tile zoom (16 in Vienna Plus, 14 in Liechtenstein), the renderer enlarges those vector tiles. This reveals the existing geometry without fetching new detail levels.
- **Find a place or street** searches names and aliases inside the package: try `Vaduz`, `Landstrasse Vaduz`, or `Städtle`. Click a result to zoom to it. Search is case/accent insensitive and treats ß as ss; it is not a fuzzy global address search.
- **Coordinates → nearest street** accepts explicitly labelled **latitude, longitude**. Try `47.13929, 9.52280`: it finds **Städtle**, about **16 m** away. Or use **Pick on map**; Enter picks the center and Escape cancels.
- A search result can become a routing endpoint using **Route from here** / **Route to here**. Search and routing share one active map-picking mode.
- Location names and reverse street geometry are separate blocks, loaded only as needed. Test each operation in **Cache only** before and after its first successful lookup. Cached query results need no further server reads; map tiles still load independently.
- **Try Vaduz → Schaan** in **Go somewhere** computes a walking route inside the browser. The first request fetches one verified `routing/walking` block; later routes reuse it.
- Choose **A** and **B** on the map to route between your own points. Pan/zoom while selecting; keyboard users can pan with arrows and press Enter to select the center. **Reverse**, **Find route**, and **Clear** are available.
- Try **Cache only** before any route: the missing graph is reported explicitly. Load a route online, then enable it and reverse the route: no new graph request is made. Rendering tiles can still be missing while routing works.
- Toggle individual map layers and tile boundaries. Roads, footways, rail lines and waterways widen smoothly with zoom. Roads and paths have subtle borders, and railways gain a twin-edge stroke. Their **Style** width controls adjust thickness without downloading more data.
- **Find the highest peak** fetches `query/peaks`, computes the maximum locally, and moves the camera to the result. It works independently of which vector tiles are loaded.
- Enable **Cache only**, then move to another zoom/area: missing tiles are reported as partial. Re-enable network reads to finish the view. This is a session memory cache, not a persistent offline download.
- Download the package, then use **Open a local file**. Data reads now use `Blob.slice`; the map package no longer comes from the server. After the app reports it is saved for offline use, its service worker also serves the HTML/JS/WASM without a network connection. You must explicitly reopen your saved map file.
- Inspect byte counts, actual range reads, and a pinned snapshot in the right panel. The panel is hidden on narrow screens.

## CLI

```sh
bun run cli --help
bun run cli fetch --format json
bun run cli generate --min-zoom 9 --max-zoom 14
bun run cli inspect --format json

bun run cli fetch --url https://example.org/region.osm.pbf --out data/region.osm.pbf
bun run cli generate --input data/region.osm.pbf --output data/region.atlas --name "My region"
ATLAS_FILE=data/region.atlas bun run start
```

The default input is pinned to `https://download.geofabrik.de/europe/liechtenstein-261006.osm.pbf`. The observed SHA-256 is `9e1ec2e5e987ff85c1336d6a1fc885b5afed2a9645ba67d48810d1f6cf752122`. `fetch --sha256 HASH` explicitly verifies an expected digest. Existing downloads are reused only when their source sidecar and checksum match. Generated files, downloads, and build output are ignored.

`fetch` and `generate` support `--dry-run`. All commands support `--format md|json`. A custom URL must supply an OSM PBF, not a rendered tile archive. The importer retains regional source data in memory; generation stops above 500,000 candidate tiles. Payload blocks are compressed and spooled to disk. `--max-bytes` defaults to 2 GB; `--no-source-features` omits the monolithic source GeoJSON debug block. `--features` adds independently paged source geometry for object selection/export; the Vienna recipe enables it. Use Osmium for PBF preprocessing, or draw a polygon in the app to extract a smaller `.atlas` file.

## Verification

```sh
bun run build # includes WASM required by the integration tests
bun run typecheck
bun test
cargo test --workspace
```

53 Bun tests cover packaging/HTTP behavior, the actual Rust/WASM routing ABI, location search ranking/aliases/context, nearest-segment street lookup, coordinate validation, independent offline availability, corrupt blocks and concurrent reads. Additional tests cover compression bounds, polygon clipping, direction-preserving graph cuts, offline export and atomic file-size budgets. Tests also exercise a real Vienna building PBF, courtyard preservation, label placement and offline label retention. 22 native Rust tests cover access rules, pedestrian directionality, barriers, edge snapping, shortest paths, graph validation, disconnected crossings, rendering codecs, line joins, continuous stroke widths and unchanged water-area geometry. A visible Chromium check exercises the real sample: routing, offline retry, cached reverse, drag versus click selection, local-file routing, and a 390 px mobile layout. The existing rendering/peak-query smoke flow is also checked, together with zoom 20, forward/reverse geocoding, map-picker ownership and search-to-route handoff.

## Original small sample

The source produces 36,791 retained features, 174 tiles (z9–14), 57 peaks, and a walking graph with 106,395 nodes / 111,803 segments. The package is 30,811,870 bytes (~29.38 MiB), deliberately uncompressed and including a full retained-feature GeoJSON block. The graph occupies 4,789,552 bytes (~4.57 MiB), fetched only when routing is requested. There are 3,104 searchable locations in a 509,668-byte name block and 7,696 street ways in a 2,512,099-byte geometry block. Rendering still loads only the visible tile blocks. Viewport/device changes alter transfer counts. The maximum recorded numeric peak elevation is Vorder Grauspitz at 2,599 m; 56 peaks have numeric elevations, one is unknown.

The sample Vaduz → Schaan route is approximately 3.45 km (~43 minutes at a constant 4.8 km/h). Observed routing computation was roughly 10–11 ms in desktop Chromium, including snapping and result serialization but excluding graph download/initial decode. This is one local observation, not a benchmark guarantee.

CPU draw timing measures the synchronous render submission call, not complete GPU time or frame rate. This demo makes no performance claim against another renderer.

## Deliberate boundaries

- Renderer is currently a browser WebGL2 backend controlled by Rust/WASM. Native rendering and WebGPU are future work. Tile decoding and tessellation have native Rust tests.
- Polygons include closed ways, building parts and nested multipolygon relations with courtyards. Incomplete/ambiguous rings and cyclic or excessively deep relations are skipped and counted in the manifest. Source import keeps selected display ways, peaks, named location nodes and walking topology, not the complete OSM object graph.
- Walking routing uses one graph block, linear nearest-segment snapping (150 m limit), and Dijkstra shortest distance. No driving/cycling profiles, turn relations/instructions, terrain/difficulty costs, conditional access evaluation, national access defaults, imagery, terrain, or Hashtree transport. Unsupported conditional/access values are conservatively excluded. See the exact [walking profile](docs/ROUTING.md).
- Geocoding uses TypeScript, in-memory name scans and bounding-box-filtered street segment projection. No house-number matching, address interpolation, typo correction, administrative hierarchy or external search provider. Nearest street is scoped to retained road/pedestrian-street/track types within 1 km; it is not a postal address or accessibility claim. See [geocoding details](docs/GEOCODING.md).
- Graph coverage is the retained source extract, not a complete worldwide network. A missing graph, an unsnappable point, and no path in the loaded graph are distinct outcomes. No-path is not proof of real-world disconnection. Graph partitioning and fetching missing graph regions during search are future work.
- Peak results cover the source extract, which can include data beyond the political border. They are exact over retained peaks with known numeric elevations, not a claim about all physical terrain.
- Tile directories are paged by region and zoom. The root label catalog, query tables, and importer are still in-memory prototypes. Decoded-byte caches are not bounded for planet-scale use. GPU tiles are released when they leave the viewport. Server pins the entire selected package in memory at startup to prevent mixed-version range reads.
- Packages contain independent block hashes. Snapshot identity is a deterministic digest, not a signature or publisher trust system. Readers do not authenticate metadata against a trusted external root.
- The reader supports experimental wire versions 1 (flat directory) and 2 (paged directory). CLI and browser exports now write v2. Breaking changes are expected.

## Data credit

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under ODbL 1.0; regional extracts from [Geofabrik](https://download.geofabrik.de/europe.html). Attribution is embedded in the package and displayed by the demo.

## Request data for a purpose

The **Data → On the map** checkboxes configure downloads as well as visibility. Choose any combination of landscape, water, buildings, roads, railways and peaks, plus separate settlement, street-name and POI labels. Choices are saved before the next page load. Buildings first appear at z13 in regenerated files. Offline exports use the same selection.

With only buildings + water, a cold 1600×1000 Vienna view through z11–17 read **2.64 MB including metadata**: **1.50 MB buildings**, **105.8 KB water**, and **zero bytes of other geometry or labels**. Enabling roads afterward fetched only road blocks. Previously downloaded bytes remain in cumulative counters; disabling a layer stops future requests but does not undo completed or in-flight transfers.

Consumer code can choose layers at creation or change them later:

```ts
const map = await AtlasMap.create(canvas, reader, onStats, onError, {
  layers: ["buildings", "water"],
  placeNames: false,
  streetNames: false,
  pois: false,
});
map.setLayers(["water", "railways"]);
// For a reader without the renderer:
const blocks = await reader.tiles(z, xmin, xmax, ymin, ymax, [
  "buildings",
  "water",
]);
```

New CLI builds separate layers by default. Existing packages can be converted without importing OSM again:

```sh
bun run cli split-layers --input data/region.atlas --output data/region.layered.atlas
```

Older combined packages still render, but the UI explicitly identifies their visibility-only switches. [Layer layout and verified Vienna counts](docs/VIENNA-PLUS.md#selective-display-layers).

Before layer separation, the directory/geometry optimization reduced the Vienna all-layer browser path (1440×1000, default center, z11 → z17 without panning) to **1.75 MB initially / 7.49 MB cumulatively**, versus **30.03 MB / 53.88 MB** before this change. Measurements count `.atlas` range payloads, excluding the small app shell/WASM. That revision reduced root metadata from 24.10 MB to about 0.52 MB; the new layer catalog uses 0.706 MB. Per-purpose transfer counters are shown in the inspector.

- Tile-directory pages are fetched only for the selected layers, region and zoom.
- Display geometry has zoom-appropriate detail; stored z16 retains full detail and all levels z0–16 remain present.
- Street names and POIs have separate first-visible zoom tiers. Turning either off avoids its future payload requests.
- Routing, geocoding, queries and source geometry load only on explicit use. Disable them in Data to block tool use and future payload reads. Routing/search remain regional blocks; source geometry is paged by category and region. Server mode returns results without downloading these source blocks.
- Offline export includes selected display layers and labels. Add routing, search or peak queries explicitly.

A restricted consumer can make the contract explicit:

```ts
const reader = await new AtlasReader(new HttpSource(url), onRead, {
  purposes: ["map", "labels"],
}).open();
// Optional semantic payloads fail before a range request is made.
```

While drawing, use the **Finish area** button over the map or **Enter** after three corners. **Space** adds the map center, **Undo** removes the last corner, and **Escape/Cancel** abandons the drawing. The toolbar stays with the map on mobile.

## Live styling and 3D

**Style** offers three palettes, individual colors, line-weight, building-edge and label-size dials, validated style JSON import/export, and saved appearance. Paint changes update GPU uniforms without fetching tiles or re-uploading meshes. **Inspect in 3D** adds an orthographic tilted view with depth-tested, shaded building extrusions. Buildings use tagged OSM heights, floor estimates, or a disclosed fallback. Right-drag or Command + drag to orbit; Mac trackpads also support Command + two-finger scrolling. The map’s **Top-down** button resets tilt and bearing. Height scale, unknown-height fallback and shading remain adjustable. Terrain and perspective are future work. Picking and overlays share the ground camera.

See [the styling contract and 3D roadmap](docs/STYLING-AND-3D.md). The proposed planet stack is budgeted at **1–2 TB per complete snapshot**, with substantial compiler/index/serving changes required first. [Planet storage, hardware estimates and evidence](docs/PLANET-SIZING.md).

Integer zoom transitions retain the current visible geometry until the next detail level is ready. The renderer reports when previous detail is being used while new tiles load. Buildings now have subtle footprint/roof outlines, adjustable from **Style → Building edges** without loading more data.
