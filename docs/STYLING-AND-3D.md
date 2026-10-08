# Styling and the third dimension

Implemented in prototype 007. The map data and `.atlas` snapshot are unchanged.

## Try it

Open **Style**. Choose **Paper**, **Midnight** or **Blueprint**, change individual colors, adjust road/path/rail/waterway weight and label size. Export the result as a small `.style.json` and import it again. Appearance and scene settings persist in this browser and survive switching packages. Import validates the entire document before changing the map; unsupported versions, unknown fields, unsafe color strings and out-of-range values are rejected. The demo limits imported styles to 16 KB.

**Inspect in 3D** keeps the current center, zooms to at least z17, sets tilt to 52°, bearing to −25°, and raises footprints to an illustrative 18 m. Tilt, bearing, height and face shading are independent dials. **Back to 2D** restores a flat north-up camera. The Buildings layer still needs to be enabled in Data and present in the package at the current zoom.

The ordinary display footprints supply roof triangles and courtyard/outer wall triangles. The GPU depth-tests buildings, colors faces with directional shading and projects the scene orthographically. This is actual geometry with height and occlusion between buildings, not a CSS transform. Flat views draw only roof triangles. No extra dataset or format migration is needed.

**Heights are illustrative, not OSM measurements.** All buildings have the same selected height, with a visible disclosure on the map. Display tiles currently contain class and geometry but no per-feature height or identity. Tile-cut boundaries can produce artificial walls; overlapping building parts are not resolved into a solid model. There is no terrain, perspective, roof-shape modeling, cast shadows, transparency ordering, 3D feature picking, or native/WebGPU backend. Labels, routes and selectable extracted shapes remain Canvas2D annotations drawn above the scene; they follow the ground projection and do not occlude behind buildings. Coordinate picking intersects the ground, not a roof.

## The styling contract

Keep three independent descriptions:

| Contract          | Question                                        | Current API                                                         |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Data subscription | What may this consumer fetch?                   | `setLayers(["buildings", "water"])`, reader purposes, label choices |
| Paint             | How should available data look?                 | `setStyle(style)`                                                   |
| Camera / scene    | From where and with what illustrative geometry? | `setScene(scene)` plus center/zoom                                  |

**JSON remains a good exchange format.** [MapLibre's specification](https://maplibre.org/maplibre-style-spec/) is an existing example of declarative map styling. The improvement belongs in the model and execution, not in replacing JSON syntax. A small validated semantic document is easy to save, diff, share through Nostr or content-address, and compile on web/native/server. We do not need to clone a large vendor style specification or let style files execute arbitrary JavaScript or trigger arbitrary data requests.

The implemented v1 describes background color, the eight existing display classes, line-width multipliers and label paint. `parseStyle()` owns validation and returns an independent copy; `compileStyle()` lowers it to RGB and width arrays. Rust/WASM draws the same uploaded geometry with changed uniforms. Label size affects text measurement and collision boxes, not label data acquisition. JSON does not contain URLs, camera state, data subscriptions or scripts.

```ts
import { AtlasMap } from "../packages/renderer/src/map";
import { parseStyle, STYLE_PRESETS } from "../packages/renderer/src/style";

const style = parseStyle(STYLE_PRESETS.paper);
style.colors.buildings = "#527e95";
style.widths.roads = 1.8;
const map = await AtlasMap.create(canvas, reader, onStats, onError, {
  layers: ["buildings", "water"],
  streetNames: false,
  pois: false,
  style,
});
map.setStyle(style); // Paint only: no tile re-fetch or mesh upload.
map.setScene({ pitch: 52, bearing: -25, buildingHeight: 18, shading: 0.8 });
// Moving/tilting the camera can expose additional tiles; height also expands roof coverage.
```

The typed source of truth is `packages/renderer/src/style.ts`. An exported document is a complete style, not a patch; the app's controls edit a copy and submit it. Widths are multipliers on the prototype's class widths, and are compressed by tilt with the ground. View zoom and styles do not change routing geometry or source geometry precision.

## Next contract, without inventing a giant language

This is a direction, not implemented functionality:

1. **Semantic paint and reusable tokens.** A theme can map semantic roles such as surface, structure, water and mobility to paint. Style authors should not have to enumerate a generated forest of vendor-specific tile layers. The v1 class vocabulary is deliberately small; highway subtypes, zoom interpolation and full OSM tag predicates require richer columns.
2. **A typed expression IR.** Add bounded expressions for properties, zoom, arithmetic, color ramps and conditions; compile once to GPU attributes/uniforms or CPU label layout. Make units explicit (meters, pixels, degrees) and keep evaluation deterministic. Native and WASM should consume the same IR. JSON/TS authoring both produce that contract.
3. **Explain the data dependencies.** An expression using `height` or `population` declares those columns. A planner reports the required blocks and missing fields; the caller authorizes that subscription. Recoloring a building must never silently load a search index. Missing values and fallbacks should be inspectable.
4. **Separate immutable data identity from style identity.** The same data hashes support multiple styles. Share a style digest and a scene/camera separately from the `.atlas` snapshot; a future manifest can recommend a default style without baking it into geometry. Exporting an offline map need not duplicate its geometry for every theme.
5. **Use one scene for basemaps and visualization.** A layer interface should take typed geometry/attribute buffers, bounds, a picking identity and explicit dependency declarations. Polygons, elevated paths, points, columns and GPU aggregation can share the camera, depth buffer and tile/cache scheduler. Input may be `.atlas`, GeoJSON or analytical result buffers. This is the useful direction from [deck.gl's composable layer model](https://deck.gl/docs/developer-guide/using-layers); compatibility with its API is not required. Its [PolygonLayer](https://deck.gl/docs/api-reference/layers/polygon-layer) is a useful reference for extruded geometry, not evidence of feature/performance parity in this prototype.

Next worthwhile demos: preserve `height`, `min_height` and `building:levels` in optional display columns and extrude measured/fallback heights distinctly; draw population or POI-count columns; elevate a route by real terrain data; add GPU picking with stable feature IDs. Terrain and imagery are independent subscribed sources, not inferred from OSM footprints.

## Implementation and verification

- Rust geometry buffers now store position, stroke offset, normalized height and face normal. Paint moved out of the meshes into GPU uniforms. Building walls are prepared once per loaded tile and skipped in flat rendering.
- A shared TypeScript orthographic transform mirrors the vertex shader. Panning, cursor-anchored zooming, bounds/fit, grid, labels, feature overlays, route annotations and offline polygon input use it. Visible ground bounds include elevated roofs whose bases are just outside the viewport.
- Native tests verify roof area and courtyard exclusion plus walls on both boundaries. Camera tests cover projection/inverse picking, tilted bounds, rotation, fitting and zoom anchoring. Style tests cover validation and mutable-state isolation.
- A visible Chromium check measures map HTTP ranges and WebGL `bufferData` calls around palette, line-weight, label-size and shading edits. Both remain unchanged while rendered pixels change. It also checks JSON round-trip/rejection, persisted appearance, tilted coordinate picking against an independent calculation, polygon finishing, mobile overflow and tab keyboard navigation.

The draw-time counter remains CPU submission time, not a GPU frame-time benchmark. No performance comparison with MapLibre/deck.gl is claimed.
