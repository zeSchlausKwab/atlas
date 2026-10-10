# ATLAS experimental wire formats / 1 and 2

Status: prototype. There is no compatibility promise. All binary integers are little-endian.

## File layout

```
[32-byte header][UTF-8 JSON manifest][UTF-8 JSON root directory][block payloads][directory pages]
```

| Offset | Type    | Meaning                                               |
| ------ | ------- | ----------------------------------------------------- |
| 0      | 8 bytes | ASCII `ATLAS001`                                      |
| 8      | u32     | Wire version: 1 (flat) or 2 (paged)                   |
| 12     | u32     | Manifest byte length                                  |
| 16     | u32     | Directory byte length                                 |
| 20     | u32     | Payload start (32 + both JSON lengths)                |
| 24     | u64     | Total file length (reader requires a safe JS integer) |

The reader supports both versions and caps root metadata at 64 MiB. CLI generation and browser extraction write v2. Directory leaves are independently compressed and hashed. Malformed headers, unsupported versions, truncated metadata, duplicate keys, overlapping entries within a directory and out-of-bounds blocks fail explicitly. The manifest schema version remains 1; the header selects the directory layout.

## Manifest

Contains format/version, display name, source URL and PBF SHA-256, OSM attribution, longitude/latitude bounds, min/max stored tile zoom, retained feature and peak counts, a legacy place-label list (empty in new packages), capabilities, limitations, and a snapshot digest. Bounds are the envelope of retained source features, not an authoritative country polygon. Dateline-spanning sources are not specially handled.

Capabilities in this implementation: `vector-rendering`, `peak-query`, `source-feature-export`, `walking-routing`, `paged-walking-routing`, `transport-routing`, `location-search`, `reverse-street`, `map-labels`, `feature-extraction`, `building-heights`.

Routing-enabled packages also declare `routing: {profile: "walking-v1", block: "routing/walking", nodes, segments, bytes, skippedWays, snapLimitMeters: 150, scope: "retained-source-extract"}`. The optional `routing.cells: {zoom: 14, count, codec: "rcl1"}` and `paged-walking-routing` capability select paged search. The count must match the spatial directory. Routing is optional; older packages without the capability still render. Display zoom ranges do not govern routing detail.

The snapshot is SHA-256 of UTF-8 `JSON.stringify({manifest, blocks})`, where the manifest excludes `snapshot` and `blocks` is the ordered list of `{key, hash}` for uncompressed blocks and `{key, hash, codec, rawLength}` for compressed blocks. This prototype uses the writer's field order; it is not a language-independent canonical JSON standard. V1 excludes offsets from snapshot identity. V2 hashes `JSON.stringify({manifest, pages, blocks})`, with complete ordered page descriptors in `pages` and the same reduced descriptors for root `blocks`; page hashes cover all tile descriptors, including offsets. The reader checks per-block hashes and HTTP version consistency; it does not independently recompute or authenticate the snapshot digest.

## Block directory

V1 stores the complete JSON array. V2 stores `{blocks, pages}`: `blocks` holds non-spatial entries (labels, routing, search, queries), while `pages` points to gzip-compressed spatial directory arrays at the end of the payload. Each page covers a 32 × 32 tile-address region at one zoom and has key `index/tiles/z/pageX/pageY`, where pageX/Y are floor(tileX/Y / 32). It adds `z`, `x`, `y` (page coordinates), and `count` to a regular compressed-block descriptor. Source-geometry pages use `prefix: "features/<kind>"` and key `index/features/<kind>/z/pageX/pageY`. Routing pages use `prefix: "routing/cells"` and key `index/routing/cells/14/pageX/pageY`. Absent `prefix` means legacy display tiles. Page contents must belong to the declared prefix and region, match its count and precede the directory-page payloads. The root cannot directly contain spatial block descriptors.

The root contains every page pointer and label descriptor; neither is recursively paged yet. `reader.index.blocks` means root entries, not all blocks. Use `reader.tiles(z, xmin, xmax, ymin, ymax, layers?)` for display geometry, `reader.spatial(prefix, z, xmin, xmax, ymin, ymax)` for source geometry or routing cells, or explicitly `reader.allBlocks()` for an audit. `index.tileCount` counts physical display blocks (multiple layers can share one spatial tile address); `index.blockCount` counts all data blocks. Both totals are available without loading leaves. Cached directory pages and pending reads are shared across callers; an uncached page in cache-only mode is a missing-data error.

Each data-block entry has:

- `key`: unique logical identity, e.g. `tile/12/2156/1439`, `query/peaks`, `features/geojson`.
- `offset`: relative to the payload start.
- `length`: exact stored byte length.
- `hash`: SHA-256 of stored bytes as lowercase hex.
- `features`: number of features represented.
- `z`, `x`, `y`: present for tiles, in the Web Mercator XYZ scheme.

Blocks optionally carry `codec: "gzip"` and `rawLength` (exact decoded length). Hashes and byte offsets describe the stored compressed bytes. The reader checks SHA-256 first, decompresses with a streaming length bound, and caches decoded bytes. A missing codec means uncompressed data, so existing packages remain readable. Decoded blocks are capped at 768 MiB; routing cell descriptors have a tighter 16 MiB cap. Routing `bytes` describes the decoded RTE1 block and is checked against `rawLength ?? length`. HTTP content encoding must preserve range offsets.

The CLI spools compressed blocks to disk and writes the header/index plus payload to a temporary file before atomic rename. `--max-bytes` checks the complete file, including metadata. Browser extraction writes the same paged layout with Blob parts. The in-memory `encodePackage` helper accepts `{paged: true}`; its default remains the legacy fixture layout.

## Vector tile block

Tile identity lives in the directory. The tile stores display geometry, not a routing graph.

```
magic:          4 bytes ASCII TIL2 (legacy TIL1 also readable)
feature_count:  u32
repeat feature_count times:
  class:        u8
  geometry:     u8 (1 point, 2 line, 3 polygon)
  part_count:   u16
  if TIL2 and class == 2:
    height:      f32 (meters, -1 means unknown)
    min_height:  f32 (meters above ground)
    source:      u8 (top/base provenance bit pairs)
  repeat part_count times:
    point_count: u32
    repeat point_count times:
      x:        u16
      y:        u16
```

Coordinates occupy `[0, 65535]` in tile space; x increases east, y south. Point features use one part containing their points. Line parts are independent paths. Polygon parts contain closed rings; outer rings share a winding direction, and opposite-winding holes follow their outer ring. A new outer ring starts another polygon. The decoder limits tiles to 500,000 features and 3,000,000 points and rejects trailing bytes, bad geometry classes, and truncation.

Height `source` bits 0–1 describe the top (0 unknown, 1 explicit height, 2 floor estimate); bits 2–3 describe the base (0 ground, 1 explicit min_height, 2 minimum-level estimate). Unknown roofs use the client fallback **above** the base; known roofs are absolute heights above local ground. Readers reject non-finite/out-of-range heights, inconsistent provenance, and bases at/above a known top. TIL1 has no attributes and uses fallback heights. TIL2 retains identical geometry encoding. New readers accept both; old TIL1-only readers cannot render TIL2. The outer container wire version is unchanged.

The optional manifest `buildingHeights: {tagged, estimated, missing, maxMeters}` reports source-building counts and the maximum of retained top/base heights. Offline exports count repeated tile records instead, consistent with `featureCountKind: "tile-records"`. `building-heights` announces the attributes. Height fields follow OSM tags, with 3 m/floor estimates; no terrain elevation is implied.

Classes: 0 landscape, 1 water, 2 buildings, 3 local roads, 4 major roads, 5 paths, 6 rail, 7 peaks. Client style paint is passed as GPU uniforms. Buildings enter at z13, service roads and paths at z14, residential roads at z12 and tertiary roads at z11. Major roads appear progressively by class. Normal map zooms use geojson-vt tolerance `65535 / 512`, equivalent to half a CSS pixel on a 256px tile. Overview z0–5 uses tolerance 5 and overview classes to retain the small regional footprint. At the stored maximum geojson-vt preserves unsimplified geometry. Tile buffer is zero. The WASM renderer decodes, tessellates polygons, expands line segments into screen-width triangle strips, creates peak triangles, and submits WebGL2 draw calls. Roads, paths, waterways and rail lines have bevel joins and square endpoint caps. Their widths interpolate with view zoom. Road/path casings and railway insets reuse the same GPU buffers; water-area vertices have zero stroke offsets, so their boundaries do not change with line width. Paint changes do not change package bytes. Labels remain a separate data and rendering path.

The camera can zoom to 20 independently of the stored maximum. Beyond that maximum, it uses the stored highest-zoom tile geometry with larger transforms (overzoom). No additional higher-resolution source geometry is implied. Vienna Plus stores through z16 and overzooms only z17–20.

## Independent display layers

The optional manifest field `tileLayers` declares a subset of `land`, `water`, `buildings`, `roads`, `railways`, `peaks`. New generator output includes all six. Their class masks are 1, 2, 4, 56, 64 and 128 respectively. A tile payload contains only one group and uses key `tile/<layer>/z/x/y`, while retaining its numeric `z/x/y` fields and TIL1 or TIL2 encoding. Empty layer tiles are not stored.

Each layer has its own directory pages: `prefix: "tile/<layer>"`, key `index/tile/<layer>/z/pageX/pageY`. Requesting only buildings and water loads only those page families and payloads. Without `tileLayers`, legacy `tile/z/x/y` and `index/tiles/z/pageX/pageY` remain readable and require combined geometry reads. The empty requested layer list loads no geometry; labels remain independent.

`AtlasMap.create(..., {layers: ["buildings", "water"], placeNames: false, streetNames: false, pois: false})` applies the selection before the first render. `map.setLayers([...])` changes it during use; numeric class masks remain supported. The WASM renderer stores geometry under its complete block key so layers at the same tile address coexist without overwriting one another. Missing geometry classes do not allocate GPU buffers.

The CLI `split-layers` command copies individual binary feature records without changing coordinates, parts, winding, holes or feature counts. Non-map stored payloads retain their hashes. It writes a new index/snapshot and publishes only after the file-size budget passes. Layer separation increases directory entries, compression overhead and all-layer request counts; it enables smaller targeted transfers.

Offline `Selection` accepts `layers`, `placeNames`, `streetNames` and `pois`. Planning reads selected spatial directory pages, exports only matching payloads and filters labels independently. Defaults preserve the previous all-layer export API. A legacy combined source must still be read before it can be split during export. A child can retain the parent zoom range even when its selected layer has no objects at a lower zoom.

## Query blocks

`query/peaks` is a JSON array of `{id, name, coordinates: [lon,lat], elevation: number|null}`. Elevations accept numeric metres and an explicit `m` suffix. Other units and non-finite values stay unknown. The current operation reads the whole small query block, chooses the maximum known elevation, and returns known/unknown counts, snapshot, and scope. No spatial maximum tree exists yet.

`features/geojson` is the retained source feature collection. It preserves identifiers and tags for selected ways, and basic name/elevation properties for peak points. Display tiles omit these properties. The map does not fetch this block for rendering. `--no-source-features` omits it and its capability; the Vienna recipe uses this option.

## Geocoding blocks

`location-search` requires `search/locations`, UTF-8 JSON with `{schema: "locations-v1", records: [...]}`. Each record has `id` (OSM node/way/relation reference), `name`, string-array `aliases`, `kind` (`place`, `street`, `poi`, `peak`), `category`, representative `[longitude, latitude]` coordinates, and optional `context` such as `near Vaduz`. Context is proximity to a retained settlement, not an administrative assertion. Records are sorted by identity. Named street fragments are grouped by normalized name and nearest retained settlement (within 10 km); the chosen representative retains an actual OSM way ID and lies on one source segment.

`reverse-street` requires `search/streets`, UTF-8 JSON with `{schema: "streets-v1", streets: [...]}`. Each street is `{id, name: string|null, aliases: string[], category, coordinates: [[longitude,latitude],...]}`. It retains each eligible source way independently, including unnamed ways, with unsimplified coordinates. The source compiler includes non-area highway values motorway/trunk/primary/secondary/tertiary and their links, unclassified, residential, living_street, service, pedestrian, road and track. Other types, including standalone footways and paths, are excluded. No walking-access policy is applied to this lookup index.

The reader verifies a block hash before JSON decoding, then validates schema, IDs, coordinates, names/aliases and bounded record counts. Name blocks allow at most 1 million records; street blocks allow at most 1 million ways / 10 million points. Coordinates are finite with longitude ±180° and latitude ±85°. The prototype assumes a regional, non-dateline-spanning extract.

Name and street blocks load independently and are reusable in cache-only mode. Search returns ranked name matches with snapshot/scope; reverse lookup returns the nearest eligible segment within 1,000 m or a scoped null result. Missing/corrupt bytes remain errors. See [GEOCODING.md](GEOCODING.md) for algorithms, API and limits.

## Walking graph block

`routing/walking` is a topology block, independent of vector tile geometry and zoom. The importer retains every eligible way segment between consecutive OSM node IDs, using original coordinates before tile simplification. Shared node IDs create junctions; geometric intersections alone do not. Nodes are sorted by OSM ID, segments follow source way order.

```
magic:          4 bytes ASCII RTE1
node_count:     u32
segment_count:  u32
repeat node_count times (24 bytes):
  osm_node_id:   i64
  longitude:     f64
  latitude:      f64
repeat segment_count times (20 bytes):
  a:             u32 node-array index
  b:             u32 node-array index
  osm_way_id:     i64
  directions:    u8 (bit 0: a → b, bit 1: b → a)
  reserved:      3 bytes, zero
```

Only direction values 1, 2, and 3 are valid. The decoder requires exact length, unique node IDs, finite coordinates within ±180° longitude / ±85° latitude, in-bounds distinct node indices, zero reserved bytes, and at most 8 million nodes / 12 million segments. Distinct nodes may have equal coordinates. Distances are calculated using a spherical haversine metric at load time. There are no precomputed shortcut edges, turn tables, names, or spatial snap index.

The client verifies the block hash before decoding into Rust adjacency lists. For legacy packages, `AtlasRouter.route([startLon,startLat], [endLon,endLat])` lazily loads this block and returns `found`, `no-route`, or `unsnappable`, plus snapshot and computation metadata. Missing/corrupt bytes throw a separate error. Found routes include snapped endpoints, snap offsets, coordinate geometry, meters, explored-node count, and OSM way references. Routing does not fetch or derive connectivity from display tiles. See [ROUTING.md](ROUTING.md) for the exact access profile and limitations.

## Routing cells

New packages add `routing/cells/14/x/y` entries containing `RCL1` payloads. All numeric fields are little-endian:

```
magic:             4 bytes ASCII RCL1
zoom, x, y:        3 × u32 (zoom must be 14)
graph:             complete RTE1 payload
segment_ids:       segment_count × u32, original reference-graph ordinal
```

Segment ordinals must be strictly increasing. Cell decoding requires exact length and at most 200,000 nodes / 300,000 segments, plus RTE1 validation. The directory address must match the payload. Original OSM node/way IDs, coordinates and direction flags are preserved.

The compiler replicates each full segment into every cell covered by its endpoint bounding rectangle. This conservative coverage supports snapping even when neither endpoint lies in the clicked cell, and ensures a node's owner cell contains every incident edge. There are no clipped edges, invented junctions or synthetic portals. Repeated ordinals identify the same original segment and resolve snap ties deterministically.

Cell zoom is independent of display zoom. Directory absence means no retained segment in that cell; an unavailable directory page means missing data. The retained `routing/walking` block remains the reference/export source, but ordinary paged routing never reads it. See [ROUTING.md](ROUTING.md) for the continuation protocol and budgets.

## Delivery and reads

1. Read bytes 0–31.
2. Read the JSON metadata range.
3. Request the directory leaves intersecting the viewport at its zoom, then only visible tile blocks, the query block needed, routing cells as the search frontier requires them (the full graph only for legacy/reference operations), or the name/street block on its first geocoding operation.
4. Verify each block before caching or decoding.

The HTTP reader requires 206 responses, exact Content-Range and length, and a strong ETag. It sends If-Match on later reads. The Bun server pins an immutable Blob at startup and returns 412 if a client's ETag differs. Closed, open-ended, and suffix single ranges are supported; invalid or multipart ranges receive 416. HEAD, OPTIONS, and CORS headers are supported. The local-file adapter uses Blob.slice with the same range semantics.

Cache-only mode reads memory and the optional persistent block store, then reports explicit cache misses. The demo persists compressed display/label blocks, directory pages and routing cells in a 128 MiB LRU keyed by snapshot, block key and hash. Hash verification runs on persisted reads too. The saved root permits offline reopening; missing routing cells yield a resumable `missing-data` result. It never interprets missing bytes as an empty tile or a negative query result. Empty geographic space outside the directory means no stored display tile; it does not establish completeness of the underlying real-world data.

## Polygon extracts

Optional `selection` metadata records `polygon` (unclosed lon/lat ring), `parentSnapshot`, and `boundaryPolicy`. Display blocks are complete intersecting tiles; walking and street segments are clipped to the polygon. New routing boundary nodes use unique negative i64 IDs and are never joined merely by equal coordinates. Search and peak records retain interior representative points when explicitly selected for export. Routing, search and peak queries are opt-in; map geometry and labels are the default. `featureCountKind: "tile-records"` means the manifest feature count sums display records across selected tiles and zooms. It is not a unique-source-feature count. See [VIENNA-PLUS.md](VIENNA-PLUS.md).

## Street and POI labels

`map-labels` declares `labelZoom: 12`. New blocks use `labels/12/x/y/roads/minZoom` or `labels/12/x/y/pois/minZoom`. Each record appears once, in its first-visible zoom tier (13, 14, 15, 16 or 17). Only the enabled purpose and visible tiers are fetched. Legacy combined `labels/12/x/y` blocks remain readable. The fixed spatial grid is independent of display zoom. Their JSON schema is `{schema: "labels-v1", roads: [{id, name, category, coordinates}], pois: [Location]}`. Roads are split at cell boundaries; POIs occupy the cell containing their anchor. Label blocks have no directory `z/x/y` display-tile fields. The reader validates schema, identities, geometry and bounded record counts after hash verification and decompression.

The client chooses cells intersecting its viewport and applies zoom-dependent visibility, text fitting, upright road rotation and collision suppression. It does not fetch the whole geocoder for display. Labels and POI hit targets use Canvas2D over the WASM/WebGL map. Offline export clips road label geometry and selects interior POI anchors; it retains selected labels independently of the full search-index toggle.

Optional `areas: {assembledRelations, skippedRelations}` records importer diagnostics. Flat multipolygon outer and inner way chains are joined by original OSM node identity. Inner rings remain holes; independently tagged outer fills are suppressed when their corresponding relation was successfully assembled. Nested relation members and incomplete/ambiguous rings remain unsupported. See [BUILDINGS-AND-LABELS.md](BUILDINGS-AND-LABELS.md).

## Client data-purpose policy

`new AtlasReader(source, onRead, {purposes: ["map", "labels"]})` prevents optional payload reads before they start. Available purposes are `map`, `labels`, `routing`, `search`, `queries`, `features`, `source`. Metadata is always permitted. Omitting the option allows all purposes, but they are still lazy. `bytesByPurpose` separates directory, map, street names, POIs and semantic data; byte totals are cumulative, not current resident/view bytes. A policy is a client guard against accidental reads, not server access control. New packages declare `tileLayers` and separate geometry classes into independently fetched blocks. The map layer mask controls directory and payload requests as well as drawing. `bytesByLayer` reports these payload reads; older combined tile bytes are reported as `combined`.

## Selectable source geometry

`feature-extraction` declares `featureZoom: 12`. With CLI `--features`, source polygons and lines are placed in `features/<kind>/12/x/y`, where kind is `buildings`, `water`, `railways`, `roads` or `land`. Each independently compressed/hashed block contains `{schema: "features-v1", features: [...]}`. Its directory entries live in spatial pages, so ordinary map viewing loads only the small page pointers.

Each feature is a GeoJSON Feature with original `way/<id>` or `relation/<id>` identity, longitude/latitude geometry, bounding box, and properties `{id, name, kind, tags}`. Supported geometry is Polygon, MultiPolygon, LineString and MultiLineString. Coordinates and rings come from retained importer source geometry, before display simplification. A shape is replicated into each z12 cell its bounding box overlaps; querying deduplicates by OSM identity and tests actual geometry intersection, including holes. This prototype trades some disk duplication for independent cells.

`AtlasFeatures.query({kind, bounds, limit, tag})` returns a FeatureCollection with snapshot, attribution, total matched count and a truncation flag. Bounds are `[west,south,east,north]`, maximum 0.25° per axis; limits are 1–500 objects. `tag` is one optional exact `key=value` predicate. Returned shapes are complete source objects, not clipped tile fragments. Selecting only a portion of a line does not split it. `asPolylines()` converts polygon boundaries and inner rings into MultiLineString geometry and leaves existing lines intact.

Feature extraction is independent of display zoom and visibility toggles. In device mode it reads just the intersecting category cells; in server mode it returns matching objects without sending source cells. Offline child packages currently omit this index. See [shared operations API](SERVER-AND-EXTRACTION.md).

## Optional settlement names

New files store `labels/places` as a separate compressed, hashed root block with `{schema: "places-v1", places: [{name, coordinates: [lon, lat]}]}` and an empty `manifest.places`. It is fetched only when `placeNames` is enabled. This small regional block is not spatially partitioned yet. Legacy inline names remain readable and can be hidden but have already arrived with the root. Street names, POIs and search remain independent. Offline exports omit the block when disabled, or retain only names inside the selection polygon.

## Transport graphs and cells (RTE2 / RCL2)

`transport-routing` requires `transport: {version: 1, profiles: {walking, cycling, driving}}`. Each profile declares `{prefix: "routing/<mode>/cells", zoom: 14, codec: "rcl2", count, nodes, segments, turns, skippedWays, unsupportedRestrictions, excludedRestrictionWays}`. Counts must match their spatial directory. Graph detail is independent of display zoom. Legacy walking metadata and RTE1/RCL1 remain readable; new archives keep the old reference graph only for legacy comparison and polygon export.

RTE2 layout:

```
magic:      4 bytes "RTE2"
nodes:      u32
segments:   u32
turns:      u32
profile:    u32 (walking=0, cycling=1, driving=2)
node[nodes]:
  id: i64; longitude: f64; latitude: f64
segment[segments]:
  a: u32; b: u32; way: i64; directions: u8; reserved: 3 zero bytes
  forward_seconds: f32; backward_seconds: f32
turn[turns]:
  via_node: i64; from_way: i64; to_way: i64
  kind: u8; reserved: 7 zero bytes
```

Direction bits retain the RTE1 convention. Times are full-segment travel costs rounded upward to f32; partial snaps interpolate those costs. Invalid/nonfinite/negative costs and speeds beyond the heuristic's bound fail decoding. Kinds 0/1 mean prohibited/only turn; kinds 2/3 specialize same-way U-turns by matching the previous node. Different-way U-turns use normal way-pair restrictions. Multiple only-turn alternatives form a union; a prohibited turn still wins. Via-way restrictions and conditions are not evaluated by this prototype compiler: incoming ways are conservatively excluded and counted.

RCL2 retains the RCL1 16-byte envelope (`magic`, z, x, y) followed by RTE2 and one original segment ordinal u32 per segment. Original OSM node IDs join cells; ordinals deduplicate overlapping cell copies. Every owner cell contains all incident segments and turn rules for retained nodes. A loaded cell must match the selected mode. Directory prefixes are `routing/<mode>/cells`; page keys are `index/routing/<mode>/cells/14/pageX/pageY`.

Per-cell limits: 200,000 nodes, 300,000 segments, 50,000 turn rules, and 16 MiB decoded payload. A search retains a bounded cell cache and returns explicit `missing-data` or `budget-exceeded` results. Routes return `seconds` as well as `meters`; isochrones return snapshot-scoped GeoJSON MultiPolygon bands with seconds, minutes, envelope area, approximation flag and contour resolution. See [routing contract](ROUTING.md).

## Disk-built semantic pages

Continent builds use paged location records/postings, z14 nearest-street cells,
z8 settlement cells and a highest-peak summary with geographic peak pages.
Street/POI label descriptors are now spatially paged as well. Regional payloads
remain readable. See [partitioned compiler schemas and limits](PARTITIONED-COMPILER.md)
for the precise layouts and consumer budgets. The container version, TIL2 and
RCL2 codecs remain unchanged; semantic consumers must understand the new schema
markers rather than interpreting a paged root as a regional array.
