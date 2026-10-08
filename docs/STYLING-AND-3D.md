# Styling and the third dimension

Styling was introduced in prototype 007. Prototype 008 adds per-building height attributes, direct camera gestures and optional settlement labels; regenerate packages to get the new data.

## Try it

Open **Style**. Choose **Paper**, **Midnight** or **Blueprint**, change individual colors, adjust road/path/rail/waterway weight and label size. Export the result as a small `.style.json` and import it again. Appearance and scene settings persist in this browser and survive switching packages. Import validates the entire document before changing the map; unsupported versions, unknown fields, unsafe color strings and out-of-range values are rejected. The demo limits imported styles to 16 KB.

**Inspect in 3D** keeps the center, zooms to at least z17, and sets tilt to 52° / bearing to −25°. Right-drag (or Command/Ctrl + left-drag) changes bearing horizontally and tilt vertically. On a Mac trackpad, Command + two-finger scroll/drag uses horizontal and vertical wheel deltas for the same controls; ordinary wheel/pinch zoom remains available. Command/Ctrl/Shift + arrow keys provide a keyboard equivalent. Pitch is bounded to 0–65°. **Top-down**, always visible on the map, or **R** while the map is focused resets to north-up, flat 2D without moving the center or changing zoom. **Back to 2D** is the equivalent sidebar action. The compass and saved scene follow gestures.

Buildings start at **z13** in newly generated files. Roofs use OSM `height` where valid. Otherwise `building:levels × 3 m` plus `roof:height` (or `roof:levels × 3 m`) estimates the top. `min_height`, otherwise `building:min_level × 3 m`, raises the base. Missing heights stay unknown in the file and use the scene's **Height when unknown** (default 12 m above the base). **Height scale** defaults to 1×; it scales both bases and tops. **Extrude buildings** and face shading are separate controls. No external height source is downloaded.

The ordinary display footprints supply roof triangles and courtyard/outer wall triangles. The GPU depth-tests buildings, shades faces and projects orthographically. Flat views draw roof footprints at ground level. TIL2 stores height, base and provenance in nine additional bytes per building before compression; old TIL1 packages remain readable with fallback heights. Paint and fallback edits use uniforms without rebuilding meshes. Increasing extrusion can expose more tiles.

Tagged OSM heights are community data, not a claim of surveyed accuracy; floor-based and unknown-height estimates are identified in the sidebar. Source semantics: [height](https://wiki.openstreetmap.org/wiki/Key:height), [building levels](https://wiki.openstreetmap.org/wiki/Key:building:levels), and [minimum building level](https://wiki.openstreetmap.org/wiki/Key:building:min_level). We accept meters, `ft`/`feet`, and feet/inches, reject ambiguous lists/negative/non-finite/over-2,000 m values, and discard a base at or above a known top.

Tile-cut boundaries can produce artificial walls; overlapping building parts are not resolved into a solid model. There is no terrain, perspective, roof-shape modeling, cast shadows, transparency ordering, 3D feature picking, or native/WebGPU backend. Labels, routes and selectable extracted shapes remain Canvas2D annotations above the scene. Coordinate picking intersects the ground, not a roof.

## The styling contract

Keep three independent descriptions:

| Contract          | Question                                        | Current API                                                         |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Data subscription | What may this consumer fetch?                   | `setLayers(["buildings", "water"])`, reader purposes, label choices |
| Paint             | How should available data look?                 | `setStyle(style)`                                                   |
| Camera / scene    | From where and at what height scale? | `setScene(scene)` plus center/zoom                                  |

**JSON remains a good exchange format.** [MapLibre's specification](https://maplibre.org/maplibre-style-spec/) is an existing example of declarative map styling. The improvement belongs in the model and execution, not in replacing JSON syntax. A small validated semantic document is easy to save, diff, share through Nostr or content-address, and compile on web/native/server. We do not need to clone a large vendor style specification or let style files execute arbitrary JavaScript or trigger arbitrary data requests.

The implemented v1 describes background color, the eight existing display classes, line-width multipliers, building-edge width and label paint. `parseStyle()` owns validation and returns an independent copy; `compileStyle()` lowers it to RGB and width arrays. Rust/WASM draws the same uploaded geometry with changed uniforms. Label size affects text measurement and collision boxes, not label data acquisition. JSON does not contain URLs, camera state, data subscriptions or scripts.

```ts
import { AtlasMap } from "../packages/renderer/src/map";
import { parseStyle, STYLE_PRESETS } from "../packages/renderer/src/style";

const style = parseStyle(STYLE_PRESETS.paper);
style.colors.buildings = "#527e95";
style.widths.roads = 1.8;
const map = await AtlasMap.create(canvas, reader, onStats, onError, {
  layers: ["buildings", "water"],
  placeNames: false,
  streetNames: false,
  pois: false,
  style,
});
map.setStyle(style); // Paint only: no tile re-fetch or mesh upload.
map.setScene({ pitch: 52, bearing: -25, extrude: true, fallbackHeight: 12, heightScale: 1, shading: 0.8 });
map.onSceneChange = (scene) => saveCameraPreference(scene);
map.resetView(); // Top-down and north-up; keep center and zoom.
// Moving/tilting the camera can expose additional tiles; height also expands roof coverage.
```

The typed source of truth is `packages/renderer/src/style.ts`. An exported document is a complete style, not a patch; the app's controls edit a copy and submit it. Road/path widths multiply zoom-dependent cartographic widths; rail/water widths multiply their fixed class widths; building-edge width is in CSS pixels. Both are compressed by tilt with the ground. View zoom and styles do not change routing geometry or source geometry precision.

## Next contract, without inventing a giant language

This is a direction, not implemented functionality:

1. **Semantic paint and reusable tokens.** A theme can map semantic roles such as surface, structure, water and mobility to paint. Style authors should not have to enumerate a generated forest of vendor-specific tile layers. The v1 class vocabulary is deliberately small; highway subtypes and full OSM tag predicates require richer columns. Road widths already interpolate with zoom; arbitrary user-authored zoom curves remain future work.
2. **A typed expression IR.** Add bounded expressions for properties, zoom, arithmetic, color ramps and conditions; compile once to GPU attributes/uniforms or CPU label layout. Make units explicit (meters, pixels, degrees) and keep evaluation deterministic. Native and WASM should consume the same IR. JSON/TS authoring both produce that contract.
3. **Explain the data dependencies.** An expression using `height` or `population` declares those columns. A planner reports the required blocks and missing fields; the caller authorizes that subscription. Recoloring a building must never silently load a search index. Missing values and fallbacks should be inspectable.
4. **Separate immutable data identity from style identity.** The same data hashes support multiple styles. Share a style digest and a scene/camera separately from the `.atlas` snapshot; a future manifest can recommend a default style without baking it into geometry. Exporting an offline map need not duplicate its geometry for every theme.
5. **Use one scene for basemaps and visualization.** A layer interface should take typed geometry/attribute buffers, bounds, a picking identity and explicit dependency declarations. Polygons, elevated paths, points, columns and GPU aggregation can share the camera, depth buffer and tile/cache scheduler. Input may be `.atlas`, GeoJSON or analytical result buffers. This is the useful direction from [deck.gl's composable layer model](https://deck.gl/docs/developer-guide/using-layers); compatibility with its API is not required. Its [PolygonLayer](https://deck.gl/docs/api-reference/layers/polygon-layer) is a useful reference for extruded geometry, not evidence of feature/performance parity in this prototype.

Next worthwhile demos: shade buildings by height provenance; make height attributes a separately subscribable column; draw population or POI-count columns; elevate a route by real terrain data; add GPU picking with stable feature IDs. Terrain and imagery are independent subscribed sources, not inferred from OSM footprints.

## Implementation and verification

- Rust geometry buffers now store position, stroke offset, height in meters (or an unknown-height sentinel) and face normal. Paint moved out of the meshes into GPU uniforms. Building walls are prepared once per loaded tile and skipped in flat rendering.
- A shared TypeScript orthographic transform mirrors the vertex shader. Panning, cursor-anchored zooming, bounds/fit, grid, labels, feature overlays, route annotations and offline polygon input use it. Visible ground bounds include elevated roofs whose bases are just outside the viewport.
- Native tests verify roof area and courtyard exclusion plus walls on both boundaries. Camera tests cover projection/inverse picking, tilted bounds, rotation, fitting and zoom anchoring. Style tests cover validation and mutable-state isolation.
- A visible Chromium check measures map HTTP ranges and WebGL `bufferData` calls around palette, line-weight, label-size and shading edits. Both remain unchanged while rendered pixels change. It also checks JSON round-trip/rejection, persisted appearance, tilted coordinate picking against an independent calculation, polygon finishing, mobile overflow and tab keyboard navigation.

The draw-time counter remains CPU submission time, not a GPU frame-time benchmark. No performance comparison with MapLibre/deck.gl is claimed.

## Continuous zooms and building edges

The download target and presented geometry now have separate lifetimes. At an integer zoom boundary, the current intersecting meshes continue to render under the changing camera while the target directory pages and tile meshes load. The renderer swaps to the target coverage together when it is ready. First loads and same-level pans remain progressive. Missing or failed reads retain available previous detail and report the missing data; a known-empty target clears it. Disabled layers disappear immediately. Only the current target and presented fallback meshes are retained, and fallback never triggers extra data requests. This avoids mixing parent and child geometry, which would double road widths or cover more detailed fills.

`TilePresentation` owns this policy, separate from HTTP scheduling and GPU upload. Tests cover missing directory pages, partial payloads, zoom-in/out, rapid reversals, known-empty coverage, layer removal and panning. A visible-browser reproduction held new map responses at **14.9 → 15**: before the fix the draw count fell from 164,084 triangles to zero and 65 GPU buffers were deleted; after the fix the intersecting geometry stayed visible until the replacement detail was ready.

Buildings have a subtle **0.6 px** footprint/roof outline. **Style → Building edges** accepts 0–2 px, with zero disabling outlines. The color follows the building fill at up to 24% darker, increasing contrast gradually from z13 to z15. Courtyard rims and roof height are preserved. Artificial edges along tile clipping boundaries are omitted. In 3D, edge passes use the building depth buffer so hidden roof edges remain occluded; they do not add an entire wireframe around walls.

Style JSON keeps version 1 with `widths.buildingEdges`; older saved styles missing that field receive the subtle default. This field is a pixel width, unlike the existing line-weight multipliers. The edge mesh is built once from existing footprint coordinates, requiring no new package attributes. Changing its width or palette only updates uniforms. Browser checks confirm changed pixels in both flat and 3D views with zero additional range requests and zero buffer uploads.

## Road width and joins

Roads widen continuously with fractional zoom instead of retaining a thin fixed screen width. At z16 the defaults are **6 CSS px for local roads**, **10 px for major roads**, and **1.2 px for paths**; at z20 they reach 20, 28 and 2.8 px. **Style → Road width** and **Path width** multiply those defaults and persist in the existing v1 style JSON. These are cartographic widths, not measured OSM road widths.

Local and major roads gain a subtle darker border, increasing gradually from z11 to a 0.65 px margin at z16. Both road-class border passes precede both fill passes to keep intersections open. Cached geometry is reused for these extra draws. Road/path meshes include bounded bevel joins and square endpoint caps, closing bend and fragment gaps exposed by wider strokes. Duplicate consecutive points are removed before meshing.

Native tests check corner coverage, degenerate paths, width continuity and the road-class hierarchy. A visible Chromium check covered z14–20 and tilted buildings; changing road width altered pixels with **zero new map requests and zero GPU uploads** in both flat and 3D views. Existing `.atlas` files work without regeneration.
