# Walking routing prototype

The first routing slice demonstrates the whole path: regional OSM PBF → topology → independently hashed block in the same `.atlas` file → HTTP range or local file → native-tested Rust/WASM search → interactive map overlay. The Bun server performs no routing computation.

## Using it

Regenerate older packages with `bun run data:build`, run `bun run build`, and restart the server. Choose **Try Vaduz → Schaan**, or select A and B on the map. Dragging pans without selecting. While choosing a point, Enter selects the map center. Reverse reuses the cached graph. Clear removes the route and any pending point selection.

The first route loads the whole `routing/walking` block (4,789,552 bytes in the sample). Routing works at every display zoom. With the graph cached, routes can succeed in cache-only mode even if some visible tiles are missing. A new browser session does not retain this cache; a local file also works but the app itself still needs its HTML/JS/WASM assets.

## Profile: walking-v1

This is an explicit prototype policy, not a complete regional legal-access model:

- Allowed highway families: primary/secondary/tertiary and links, unclassified, residential, living_street, service, pedestrian, track, path, footway and steps.
- Motorway/trunk and their links, motorroad=yes, cycleway and bridleway require explicit allowed access. Explicit generic access or foot access can enable them. Other highway types, including construction/proposed, are excluded. Highway areas are excluded; there is no free-space navigation across plazas.
- `foot` overrides `access`. Empty values use the above defaults; yes, designated and permissive allow passage. Other values (including no, private, customers, destination and use_sidepath) are conservatively excluded. `foot:forward` / `foot:backward` can further override the base permission for a direction.
- `oneway:foot=yes|1|true` allows the source-node order; `-1` permits the reverse; absent/no/0/false is bidirectional. Other values exclude the way. Ordinary vehicle `oneway` is not applied to pedestrians.
- Any access:conditional, foot:conditional, oneway:foot:conditional, foot:forward:conditional or foot:backward:conditional tag excludes the object. Conditions are not evaluated.
- Node foot/access denial blocks passage. Untagged nodes and barriers gate, lift_gate, swing_gate, kissing_gate, bollard, cycle_barrier, entrance and stile are allowed by default. Unknown barrier types are blocked unless explicitly permitted. Both segments incident to a blocked node are omitted; there is no artificial link around it.
- An eligible way with any missing node reference is omitted entirely and counted in routing metadata. All retained way segments preserve their endpoint node identities. Crossing geometry is never treated as an intersection by itself.

These rules are encoded in `crates/osm-import/src/walking.rs`. OSM references: [foot access](https://wiki.openstreetmap.org/wiki/Key:foot), [pedestrian one-way](https://wiki.openstreetmap.org/wiki/Key:oneway:foot), and [access restrictions](https://wiki.openstreetmap.org/wiki/OSM_tags_for_routing/Access_restrictions).

## Search and result contract

1. Snap each endpoint to its nearest eligible segment within 150 m, using a local planar projection. The graph retains OSM IDs and full source coordinate precision. The prototype scans all segments and chooses one nearest candidate; it does not try multiple disconnected alternatives.
2. Create partial start/end connections respecting direction flags. Actual node endpoints can use all of that node's adjacency. Routes between two points on the same segment use only the permitted partial distance.
3. Run Dijkstra using spherical edge length, including partial endpoint edges. Return the shortest route in this graph between the snapped endpoints. Reconstruct source geometry and way references.
4. Return `found`, `no-route`, or `unsnappable`, pinned to the package snapshot. Missing graph bytes, malformed data and integrity failures remain errors, never no-route answers.

Result distance excludes the straight dotted offsets from selected points to their snapped locations; those connectors have no walkability guarantee. The demo shows offsets explicitly. Estimated walking time is distance / 4.8 km/h, without elevation, surfaces, obstacles or difficulty adjustments. Computation timing includes snapping/search/result serialization but excludes first graph download and decode.

A no-route result is scoped to the retained graph. A valid route could leave this extract, use a way excluded by the profile, or require a different nearby snap candidate. A returned route can likewise be longer than a route outside the extract. No authoritative completeness polygon or boundary continuation exists yet.

## Limits and next steps

- One independently compressed graph block, in-memory adjacency and caches, linear snapping, synchronous WASM computation on the browser main thread. This targets regional experiments, not a planet-scale engine.
- No driving/cycling/wheelchair profiles, turn restrictions, maneuver instructions, elevation/difficulty costs, live closures, conditional evaluation, ferries or relation-based networks.
- The route line and markers use the existing Canvas2D overlay; base tiles and routing computation run in Rust/WASM. No GPU route tessellation is claimed.
- Next: a spatial graph directory, shared boundary-node IDs/portals, bounded graph caches and explicit NeedBlocks continuations. The browser can then resume a search after fetching missing graph regions. Display tiles will remain a separate representation.

Native unit tests cover codec validation, direction-sensitive partial edges, alternate shortest paths, disconnected geometric crossings, node-endpoint behavior and access policy. Bun integration tests instantiate the actual compiled WASM and read graphs through the `.atlas` reader, covering lazy acquisition, offline misses/retries, cached routing and concurrent calls.
