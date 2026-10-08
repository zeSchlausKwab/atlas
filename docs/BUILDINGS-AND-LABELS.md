# Missing buildings near Schönbrunn: diagnosis and fix

The reported Sechshauser Straße / Linke Wienzeile gaps came from **source import**, before tessellation or display. The original importer read nodes and ways but skipped OSM area relations entirely. Some building parts were also excluded, and a building tagged with railway semantics could be classified as a line.

## Evidence

The pinned Vienna PBF contains 7,708 building-tagged relations. A neighbourhood extract around Schönbrunn contained 145 building multipolygons; the original importer emitted zero relation-based buildings there. With assembly enabled it emits 141; four cannot be completed from that smaller extract. Across the full Vienna package, 15,042 building/water/landcover relations assemble and 131 incomplete/unsupported area relations are skipped. These totals include more than buildings.

The minimal reproduction is OSM **relation 2342301, Sechshauser Straße 60**, saved with its referenced ways/nodes in `tests/fixtures/sechshauser-60.osm.pbf`. Before the fix, importing this PBF produced zero display features. Afterward it produces a MultiPolygon containing an outer footprint and an inner courtyard ring. `bun test tests/import.test.ts` runs the actual native importer and checks that result, plus a POI anchor outside the courtyard.

A comparison of the old served z16 tile and the rebuilt z16 tile confirms:

| Sample | Before | After |
| --- | --- | --- |
| Footprint interior `[16.3298617994, 48.187346575]` | No building fill | Building fill |
| Courtyard `[16.3297917620, 48.1874844]` | No building fill | No building fill |

This locates the loss in import rather than a stale browser cache. Existing downloaded `.atlas` files remain old snapshots; use the rebuilt package or create a fresh offline export.

## Implementation

`crates/osm-import/src/areas.rs` joins split/reversed member ways by OSM node identity, separates outer and inner rings, assigns holes to their containing outer, and normalizes winding. The importer suppresses redundant same-class outer-way polygons so they cannot paint over a relation's holes. Building parts and building areas with additional linear tags are retained as areas. Missing members, cyclic/deep nested relations and open/ambiguous rings fail explicitly and are counted, rather than being closed with invented edges.

The source convention is documented in the [OSM multipolygon specification](https://wiki.openstreetmap.org/wiki/Relation:multipolygon). Nested multipolygon roles now compose recursively; arbitrary invalid topology is still outside coverage. The renderer now supports height extrusions but not roof shapes or shadows.

The regression would have prevented the omission earlier: it exercises a real source building at the PBF → feature boundary, instead of only testing the renderer with already-valid polygons.

## Names and POIs

The compiler adds 380 spatial label blocks (13.5 MB compressed total) to Vienna Plus. Each holds nearby named streets and POIs; these blocks use the existing hash-verified range reader. Relation POIs retain their relation IDs. Area POIs use an interior scanline anchor that avoids courtyard holes; this is a representative point, not an entrance.

Street names appear progressively from z13–17, stay upright, fit the visible road and avoid overlapping other labels. Named POIs appear from z14–17 with category colors. Clicking a marker or label opens the existing detail/routing controls. Independent layer checkboxes control settlements, street names and POIs. Labels are rendered in Canvas2D; geometry and routes still use Rust/WASM. This does not yet include unnamed amenities, house-number labels, curved glyph shaping, or a full cartographic priority system.

The browser check in the screenshot neighbourhood displayed 24 street names and 36 POIs at z17. It also tested toggling labels in cache-only mode and reopening a polygon export with the network disabled. Offline label blocks survive even when the separate search and routing indexes are omitted.

## Missing Danube fill and real height attributes (prototype 008)

At 16.34° E / 48.31° N, the Osmium reference export contained Danube relation **2742635**, but our importer emitted no river. Its inner boundary is relation **21495386** (a sand island); the previous assembler rejected nested relation members and skipped the entire water polygon. The importer now retains nested multipolygons, recursively composes outer/inner roles, then applies the existing complete-ring checks. Cycles, missing members and excessive depth fail explicitly. The exact recursive OSM fixture is committed under `tests/fixtures/`, with water and island-hole assertions. Four sampled river points agree with the reference export after the fix.

The regenerated tiles show buildings at **z13**, one zoom earlier. New TIL2 building attributes preserve OSM height and minimum height plus tagged/estimated/missing provenance. See [the height and gesture controls](STYLING-AND-3D.md). Settlement names move out of the initial manifest into the optional `labels/places` block, independently of street/POI/search data.
