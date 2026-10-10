# Atlas / geo-format

An end-to-end map stack experiment: OSM PBF → a single `.atlas` package → byte-range delivery → Rust/WASM vector rendering, walking/cycling/driving routes, network isochrones and location search on the client or server in a Bun web app.

This is a working prototype, not a finalized format or a MapLibre compatibility implementation. No MapLibre, remote basemap tiles, commercial map API, or planet download is used.

## Run it

The map server and consumer are independent apps. The server owns map files,
preparation jobs, the public API and its host console. The consumer is a static
HTML/JS/WASM build: its browser reads the remote server directly, with no API proxy.

For the deployed mini PC, start the independent client:

```sh
bun install
bun run dev
```

Open **http://127.0.0.1:5173/**. The client defaults to the direct LAN server
**http://192.168.0.179:3100/**; map viewing and remote tools need no SSH tunnel.
Port 3100 must be enabled with the [LAN firewall setup](docs/DEPLOYMENT.md#lan-firewall-setup).
Change **Client composer → Primary map server**, use a
`?server=https://maps.example/` link, or set `ATLAS_SERVER_URL` when building/running
the client. Its catalog, map ranges and server operations all use that address.
Administration retains its local-only restriction: `bun run deploy tunnel` exposes
the host console at **http://127.0.0.1:13100/host** when needed.

For a fully local setup, prerequisites are Bun, Rust/Cargo, `wasm-pack`, and the
`wasm32-unknown-unknown` target:

```sh
bun install
rustup target add wasm32-unknown-unknown
bun run setup
bun run server                     # server + host console on 3100
# In another terminal:
ATLAS_SERVER_URL=http://127.0.0.1:3100 bun run dev
```

`setup` downloads a dated ~3.3 MiB Liechtenstein PBF and builds the package and WASM.
`dev` builds the client and serves it on 5173; after frontend edits run
`bun run build:client` and refresh. `bun run dev:server` watches server code.
Rust changes require `bun run build:wasm` followed by the relevant browser build.
Restart the server after replacing a map file. `PORT` and `HOST` apply independently
to each process; `ATLAS_FILE` and `ATLAS_DATA_DIR` belong to the server only.

`dist/client/` is also a complete static website, including workers, WASM, plugins
and `client-config.json`. It can be hosted independently without Bun, OSM source
files or server code. See [server/client boundaries and configuration](docs/SERVER-CLIENT.md).

## Vienna Plus and offline drawing

**Vienna Plus is ready: 863.8 MB, 118,491 spatial tile addresses across every zoom from 0 through 16**, with three transport networks, isochrones, location search, street geometry, peaks and optional selectable source geometry. The recipe combines public Austria/Slovakia/Hungary extracts (1.48 GB total source download) and enforces a 2 GB final-package ceiling. No zoom levels are dropped to fit the budget. See [coverage, exact counts and reproduction recipe](docs/VIENNA-PLUS.md).

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

`crates/routing` contains the shared native graph codec, snapping and shortest-path engine; `crates/routing-wasm` exposes it independently of rendering. `packages/routing` connects that facade to the package reader. See [routing design and profile](docs/ROUTING.md). `packages/geocoding` compiles and reads named-location and street indexes for local forward/reverse lookup; see [geocoding design](docs/GEOCODING.md).

`apps/web` is an instrumented demo using those components. Roads, landcover, water, buildings, railways, paths, and peak markers are rendered by the WASM library. Place labels, the scale bar, grid, search/nearest-street highlights, route line/endpoint markers, and selected-peak overlay currently use a separate Canvas2D overlay.

## Try the demo

The wider sidebar has **Explore**, **Route**, **Extract**, **Offline**, **Style**, and **Data** tabs. **Run tools on** switches between this device and the server for routing, forward/reverse geocoding, peak queries, feature extraction and offline export. Local files use this device. The Data tab enables each optional capability without preloading its data.

**Extract** adds buildings, water, railways, roads or landscape areas from the current view as a selectable overlay. Click shapes or list entries, inspect their OSM tags, then download the selection as GeoJSON or polylines. Full source shapes and courtyard holes are preserved. Use an optional exact tag filter such as `water=lake`, `water=oxbow` or `railway=tram`. Source geometry loads only when requested.

**Route → Travel mode** chooses walking, cycling or driving. Routes use estimated directional travel times and mode-specific access. **How far can I go?** creates 5–30 minute areas from a chosen origin, displays nested time bands and exports contour GeoJSON. Both route and area comparison buttons verify the same result on device and server. Cached cells work offline; missing coverage pauses until resumed. [Transport contract, generation and limits](docs/ROUTING.md).

The client performance pass reduced the worst frame in the recorded cold zoom-and-pan workload from 50 ms to 18.6 ms with all labels enabled. This is a local before/after measurement, not a MapLibre benchmark. [Measurements and architecture review](docs/STACK-REVIEW.md).

The following local-data experiments assume **Run tools on → This device**:

- **City & village names** have an independent checkbox and data block; disabling them before loading avoids the name payload.
- **Street names** appear from z13 (major roads), with local streets from z15. **Points of interest** appear progressively from z14–17. Toggle each layer independently; click a POI marker or name to inspect it and use it as a route endpoint. Labels load from nearby package cells, independently of the geocoder. They remain in offline exports even when the separate search option is off.
- The missing buildings near Schönbrunn were an importer omission: relation-based building outlines never reached the tile compiler. See the [diagnosis and fix](docs/BUILDINGS-AND-LABELS.md).

- Drag or use arrow keys to pan. Scroll, use +/−, or use the buttons to zoom **up to 20**. Above the package’s highest stored tile zoom (16 in Vienna Plus, 14 in Liechtenstein), the renderer enlarges those vector tiles. This reveals the existing geometry without fetching new detail levels.
- **Find a place or street** searches names and aliases inside the package: try `Vaduz`, `Landstrasse Vaduz`, or `Städtle`. Click a result to zoom to it. Search is case/accent insensitive and treats ß as ss; it is not a fuzzy global address search.
- **Coordinates → nearest street** accepts explicitly labelled **latitude, longitude**. Try `47.13929, 9.52280`: it finds **Städtle**, about **16 m** away. Or use **Pick on map**; Enter picks the center and Escape cancels.
- A search result can become a routing endpoint using **Route from here** / **Route to here**. Search and routing share one active map-picking mode.
- Location names and reverse street geometry are separate blocks, loaded only as needed. Test each operation in **Cache only** before and after its first successful lookup. Cached query results need no further server reads; map tiles still load independently.
- **Try Stephansplatz → Praterstern** in **Route** runs resumable Rust/WASM routing in a worker, fetching only needed cells. The grid shows reused, fetched and missing coverage. Older packages without cells continue using their reference graph.
- Choose **A** and **B** on the map to route between your own points. Pan/zoom while selecting; keyboard users can pan with arrows and press Enter to select the center. **Reverse**, **Find route**, and **Clear** are available.
- Load the Praterstern route, enable **Cache only**, then reverse it without new routing reads. Try **Stephansplatz → Schönbrunn** to reach uncached coverage, then **Fetch missing cells & resume**. A missing cell pauses the frontier; it never means no route. [Algorithm, measured bytes and limits](docs/ROUTING.md).
- Toggle individual map layers and tile boundaries. Roads, footways, rail lines and waterways widen smoothly with zoom. Roads and paths have subtle borders, and railways gain a twin-edge stroke. Their **Style** width controls adjust thickness without downloading more data.
- **Find the highest peak** fetches `query/peaks`, computes the maximum locally, and moves the camera to the result. It works independently of which vector tiles are loaded.
- **Purge caches** in the header stops the current map/tools, aborts active HTTP reads and clears Atlas's decoded/GPU/operation caches, all saved block/index snapshots and the offline app shell. Other open Atlas tabs are asked to pause too. Choose **Reopen map** to start fresh; saved `.atlas` files and preferences remain. Reload online to restore the app shell. This clears Atlas-managed caches, not the browser's general HTTP cache or unrelated applications' storage.
- **Cache coverage** overlays selected geometry tiles with a blue ramp: the fraction of their existing layer blocks currently available in RAM/GPU or IndexedDB. `?` means the directory is not yet known; `∅` means no selected blocks exist. Labels/routing and other zoom levels are excluded. The toggle only inspects local state and requests no map data. RAM-only coverage is not a promise of persistence after reload.
- Enable **Cache only**, then move to another zoom/area: missing tiles are reported as partial. Re-enable network reads to finish the view. Viewed map blocks, directory pages and routing cells persist in a 128 MiB IndexedDB cache. It can be evicted; it is not a complete offline package.
- Download the package, then use **Open a local file**. Data reads now use `Blob.slice`; the map package no longer comes from the server. After the app reports it is saved for offline use, its service worker also serves the HTML/JS/WASM without a network connection. You must explicitly reopen your saved map file.
- Inspect byte counts, actual range reads, and a pinned snapshot in the right panel. The panel is hidden on narrow screens.

## Compose hosted maps

Open **http://127.0.0.1:5173/** → **Client composer**, or select maps in the host library and choose **Compose selected maps**. Combine excerpts in one WASM-rendered view, select layers per source, inspect coverage and capabilities, adjust overlap priority, and copy a view link. Add another server's public `/catalog` to compose across hosts. Walking, cycling and driving routes run on the client across excerpts of one shared compiled graph. Use the normal **Route** tab for composed routes and isochrones. **Tool source** scopes search, extraction, queries and offline export to one selected map. Legacy `/compose` links redirect into this workspace. See [composition design and limitations](docs/COMPOSITION.md).

The larger four-region demo uses cached, pinned Austria/Slovakia/Hungary PBFs, builds one shared transport graph, and then generates the full-capability map files sequentially:

```bash
bun run data:danube --dry-run # inspect the recipe without writing
bun run data:danube           # resumable; needs several GiB of temporary disk space
bun run verify:composition   # graph seams + Vienna–Bratislava routes in all three modes
```

Generated recipes, preparation records and measurements live under ignored `data/`. The composition's default 2-million-state limit accommodates the longer driving search; a smaller limit is selectable. This is a bounded regional prototype, with no hierarchical planet routing yet.

## Runtime budgets and operation discovery

The server pins a read-only file descriptor and streams byte ranges. It hashes the archive in 1 MiB chunks at startup to retain a strong ETag, so startup still reads the entire file but never allocates an archive-sized Blob. Publish regenerated archives by atomic rename, then restart the server to switch snapshots. Replacing the path while running preserves the old descriptor; modification in place is rejected.

The inspector’s **Memory & reuse** section reports retained bytes, budgets and evictions. Reader defaults are 32 MiB decoded map data, 8 MiB label bytes, 16 MiB routing bytes, 16 MiB other semantic bytes, 1 MiB temporary directory bytes and an estimated 16 MiB parsed directory descriptors. The renderer separately retains an estimated 16 MiB parsed labels/projected roads and 96 MiB GPU vertex buffers. Recently visited GPU meshes are reused when panning back. Visible meshes, transition fallbacks and visible label blocks stay pinned; an oversized active view is reported as an overage, then trimmed when released.

These are cache budgets, not a total-process limit. The immutable root, returned query results, in-flight payloads, regional parsed search/street indexes, place names, WASM linear-memory high-water marks, driver overhead and the current render/search working sets are additional memory. Oversized decoded blocks can be used for an operation without being retained in the reader cache. IndexedDB remains a separate 128 MiB compressed cache.

```ts
const reader = await new AtlasReader(new HttpSource(url), onRead, {
  cacheBudgets: { map: 24 * 1024 * 1024, routing: 16 * 1024 * 1024 },
  directoryBudget: 8 * 1024 * 1024,
}).open();
const map = await AtlasMap.create(canvas, reader, onStats, onError, {
  cacheBudgets: { meshes: 64 * 1024 * 1024, labels: 12 * 1024 * 1024 },
});
console.log(map.memory); // retained bytes, budgets, entries, evictions, active overage
```

`GET /api/capabilities` returns a versioned, snapshot-bound operation catalog without reading data payloads. It describes block families, accepted schema versions, per-profile routing dependencies, parameter limits and source-extract coverage. The same catalog is available as `AtlasEngine.capabilities`. It adapts legacy walking archives and new transport archives without a format migration; it does not claim complete coverage outside the extract. Offline polygon export still advertises walking only.

Operation requests/results have shared TypeScript contracts. The operation controller snapshots inputs, scopes cancellation to each tool, and publishes progress through subscriptions. Route and isochrone jobs share one worker channel; a newer transport job supersedes the old one. Clearing an inactive route does not cancel an isochrone. Cancelling remote work aborts its fetch; already-running server computation may finish, but its result is discarded. The server skips cancelled queued requests and keeps its bounded serialized operation queue.

## CLI

```sh
bun run cli --help
bun run cli fetch --format json
bun run cli generate --min-zoom 9 --max-zoom 14
bun run cli inspect --format json
bun run cli transport --input data/region.atlas --pbf data/region.osm.pbf --output data/region-transport.atlas

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

Bun tests cover packaging/HTTP behavior, the actual Rust/WASM routing ABI, location search ranking/aliases/context, nearest-segment street lookup, coordinate validation, independent offline availability, corrupt blocks and concurrent reads. Additional tests cover compression bounds, polygon clipping, direction-preserving graph cuts, offline export and atomic file-size budgets. Tests also exercise a real Vienna building PBF, courtyard preservation, label placement and offline label retention. Native Rust tests cover access rules, pedestrian directionality, barriers, edge snapping, shortest paths, graph validation, disconnected crossings, rendering codecs, line joins, continuous stroke widths and unchanged water-area geometry. A visible Chromium check exercises the real sample: routing, offline retry, cached reverse, drag versus click selection, local-file routing, and a 390 px mobile layout. The existing rendering/peak-query smoke flow is also checked, together with zoom 20, forward/reverse geocoding, map-picker ownership and search-to-route handoff.

## Original small sample

The source produces 36,791 retained features, 174 tiles (z9–14), 57 peaks, and a walking graph with 106,395 nodes / 111,803 segments. The package is 30,811,870 bytes (~29.38 MiB), deliberately uncompressed and including a full retained-feature GeoJSON block. The graph occupies 4,789,552 bytes (~4.57 MiB), fetched only when routing is requested. There are 3,104 searchable locations in a 509,668-byte name block and 7,696 street ways in a 2,512,099-byte geometry block. Rendering still loads only the visible tile blocks. Viewport/device changes alter transfer counts. The maximum recorded numeric peak elevation is Vorder Grauspitz at 2,599 m; 56 peaks have numeric elevations, one is unknown.

The sample Vaduz → Schaan route is approximately 3.45 km (~43 minutes at a constant 4.8 km/h). Observed routing computation was roughly 10–11 ms in desktop Chromium, including snapping and result serialization but excluding graph download/initial decode. This is one local observation, not a benchmark guarantee.

CPU draw timing measures the synchronous render submission call, not complete GPU time or frame rate. This demo makes no performance claim against another renderer.

## Deliberate boundaries

- Renderer is currently a browser WebGL2 backend controlled by Rust/WASM. Native rendering and WebGPU are future work. Tile decoding and tessellation have native Rust tests.
- Polygons include closed ways, building parts and nested multipolygon relations with courtyards. Incomplete/ambiguous rings and cyclic or excessively deep relations are skipped and counted in the manifest. Source import keeps selected display ways, peaks, named location nodes and walking topology, not the complete OSM object graph.
- Walking/cycling/driving use independently fetched cells, local segment snapping (150 m limit), estimated directional travel times and common via-node turn rules. Isochrones approximate reachable-network envelopes. Legacy walking packages retain whole-graph Dijkstra. No maneuver instructions, terrain costs, conditional evaluation, national defaults, transit schedules or Hashtree transport. See the exact [transport policies](docs/ROUTING.md).
- Geocoding uses TypeScript, in-memory name scans and bounding-box-filtered street segment projection. No house-number matching, address interpolation, typo correction, administrative hierarchy or external search provider. Nearest street is scoped to retained road/pedestrian-street/track types within 1 km; it is not a postal address or accessibility claim. See [geocoding details](docs/GEOCODING.md).
- Graph coverage is the retained source extract, not a complete worldwide network. A missing graph, an unsnappable point, and no path in the loaded graph are distinct outcomes. No-path is not proof of real-world disconnection. Search fetches missing cells within the package; crossing into other packages and hierarchical routing remain future work.
- Peak results cover the source extract, which can include data beyond the political border. They are exact over retained peaks with known numeric elevations, not a claim about all physical terrain.
- Tile directories are paged by region and zoom. The root label catalog, query tables, and importer are still in-memory prototypes. Decoded bytes, parsed directory pages, labels and GPU meshes now have separate cache budgets; semantic indexes still need paging. The server pins an open file descriptor and streams ranges without loading the whole archive into RAM. See [STACK-REVIEW.md](docs/STACK-REVIEW.md) for measured behavior and remaining work.
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
- Routing, geocoding, queries and source geometry load only on explicit use. Disable them in Data to block tool use and future payload reads. Routing uses profile-specific cells; search remains regional blocks and source geometry is paged by category and region. Server mode returns results without downloading these source blocks.
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

## Hosting and federation discussion

[Hosting, ContextVM tools and composed maps](docs/HOSTING-DISCUSSION.md) defines the proposed dataset/package/offer/view split, host UI, capability semantics and shared-snapshot Vienna–Bratislava proof. The host console now prepares and serves multiple excerpts with independently selected capabilities. It has an OpenFreeMap/local Atlas area picker, background progress/cancellation, and a persistent library. The worldwide OSM option finds a covering Geofabrik PBF, shows its full download size, downloads/crops it locally with Osmium, and compiles selected capabilities; source and output budgets are independent. Disk-aware sliders and exact inputs set arbitrary source/output budgets. The initial importer uses one covering region, not geographic byte reads from a planet PBF. [Try host preparation](docs/HOST-PREPARATION.md). ContextVM currently serves the configured source; multi-map ContextVM dispatch, announcements and federation remain future work.

[Extensible capabilities and plugins](docs/EXTENSIONS.md) develops the open operation registry, plugin SDK, data/build extensions and ContextVM tool projection. The first trusted TypeScript slice is working: a generic **Tools** tab, fingerprinted **Largest lakes** plugin, local/server comparison, GeoJSON selection/export and persisted **Host console** switches. [Try it or author a plugin](docs/PLUGIN-DEMO.md). Run `bun run demo:contextvm` for a real MCP/ContextVM round trip over an isolated local Nostr relay.

## NixOS demo deployment

`bun run deploy --dry-run` previews deployment of the current working tree. The first
release uses `bun run deploy --map data/vienna-plus.atlas --with-library`; subsequent
`bun run deploy` commands update code while retaining server maps and settings.
`bun run deploy tunnel` opens the server console at http://127.0.0.1:13100/host.
`bun run dev` serves the independent client at http://127.0.0.1:5173.
See [deployment, rollback and NixOS setup](docs/DEPLOYMENT.md) and the
[server demo roadmap](docs/DEMO-ROADMAP.md). `ATLAS_DATA_DIR` keeps runtime state
outside code releases; `/health` reports the deployed release identifier.
