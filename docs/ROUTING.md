# Transport routing and isochrones

OSM PBF → three access/cost networks → independently hashed cells in one `.atlas` file → selective range/local-file reads → shared Rust/WASM search. The browser runs it in a worker. Bun uses the identical WASM kernel and TypeScript orchestration. Display tiles do not determine graph detail.

## Try it

Open **Route** and choose **Travel mode**: walking, cycling or driving. Pick A/B, use search results, or run the supplied example. Walking/cycling use Stephansplatz → Praterstern; driving uses Schottentor → Praterstern because the nearest permitted road to the pedestrian-center origin is a small disconnected pocket. Nearest-segment snapping is intentionally explicit; it does not silently move the origin to a distant connected road.

Under **How far can I go?**, select 5, 10, 15 or 30 minutes and **Show reachable area**. Each selection displays three nested bands. Choose an origin directly on the map; Enter selects the center, Escape cancels. The default is Schottentor. Export returns GeoJSON MultiPolygons plus snapshot, profile, origin and contour-resolution metadata.

**Run tools on** selects device or server. Both comparison buttons check exact route/contour agreement. Server results do not download routing cells to the client. In device mode, **Cache only** uses existing verified cells. Missing coverage returns `missing-data`; **Fetch missing cells & resume area** continues the frontier. A disconnected browser reload can reuse persisted cells and the cached app shell. Storage eviction remains possible.

## Real Vienna check

Current archive: **863,817,861 bytes**, snapshot `855e4d74c55fe813fb7bda2605dfbb5e95f7b7fdd3cc2ada07cff3565ab95008`. All 348,408 non-cell payload hashes are unchanged by migration.

| Profile | Cells in package | Graph segments | Turn rules | Schottentor → Praterstern | Estimated time | 15-minute area cells |
| ------- | ---------------: | -------------: | ---------: | ------------------------: | -------------: | -------------------: |
| Walking |            5,542 |      3,547,639 |          0 |                   2.98 km |       37.3 min |                    4 |
| Cycling |            5,520 |      2,869,920 |      6,077 |                   3.14 km |       10.5 min |                   23 |
| Driving |            4,614 |      1,157,005 |      6,343 |                   4.29 km |        6.3 min |                   98 |

The 15-minute queries, immediately after those routes, read an additional 0.22 / 1.06 / 3.04 MiB of routing payload and take approximately 15 / 58 / 185 ms of WASM load/search/contour time in the recorded Bun run. These exclude waiting and directory bytes. Browser total operation times depend on network, cache and device. Reproduce with `bun scripts/check-transport.ts`; it does not load the whole reference graph.

## Profile policies

These are explicit regional prototype policies, not full legal-access or navigation profiles. They are implemented in `crates/osm-import/src/transport.rs` and `walking.rs`.

- Walking uses foot/access tags, pedestrian direction overrides, barriers, 4.8 km/h nominal speed, slower steps and rough surfaces.
- Cycling uses access/vehicle/bicycle precedence, bicycle one-way overrides and opposite-cycleway exceptions. Nominal speed is 18 km/h, with slower rough/path/step categories. Footways and motorway/trunk families require appropriate explicit permission.
- Driving uses access/vehicle/motor_vehicle/motorcar precedence, vehicle direction restrictions and implicit roundabout/motorway one-way rules. Road-class estimates range from 7 to 100 km/h, capped by supported numeric directional/common maxspeed tags. Foot/cycle/path/track families are excluded by default.
- Yes/designated/permissive permit access; unsupported access values and relevant conditions exclude it. Blocked nodes remove incident segments. Graph edges preserve OSM node IDs; crossing geometries never create intersections.
- Common via-node `no_*` and `only_*` restrictions are enforced, with mode exceptions and mode-specific relation tags. Same-way U-turns also track the previous node. Multiple only-turn alternatives form a union. Walking only receives explicit foot restrictions.
- Via-way, conditional and structurally unsupported turn restrictions conservatively exclude incoming ways. This snapshot excludes 1,029 cycling and 381 driving ways for these rules. Exclusion can disconnect valid real-world routes. Metadata reports both relations and unique excluded ways.

No traffic, turn delays, terrain/slope effort, country-specific defaults, live closures, ferries, public-transport schedules or maneuver instructions. Numeric maxspeed handling is a cap on modeled speed, not a legal-default resolver. Sources for OSM semantics: [turn restrictions](https://wiki.openstreetmap.org/wiki/Restriction), [conditional restrictions](https://wiki.openstreetmap.org/wiki/Conditional_restrictions).

## Search and reachability contract

The kernel snaps within 150 m of the requested point using original segment identity for stable ties. Partial endpoint connections preserve direction and travel costs. A\* minimizes estimated seconds, with spherical distance divided by a profile speed bound as its admissible heuristic. Search state includes the incoming way and previous node to enforce turns. Distances and times exclude the snap offsets; those offsets are not known traversable paths.

Isochrones use bounded Dijkstra expansion with the largest band as their time budget. Reachable directed edge portions are clipped at each time limit. A local metric raster, at least 25 m resolution and at most approximately 505 × 505 cells, produces network envelopes. Holes and disconnected components are retained. This is not a convex hull or radius. Nearby roads are buffered for visibility, so enclosed land/water is **not** guaranteed traversable. The output carries `approximate: true` and `resolutionMeters`; the area field measures the envelope, not accessible land area.

A search requests owner cells when expanding nodes, and pauses with its queue/predecessors intact if bytes are missing. Cells can be evicted without losing reconstruction. Outcomes are `found`, `reachable`, `no-route`, `unsnappable`, `missing-data`, or `budget-exceeded` as applicable. Corrupt or inconsistent bytes are errors. A budget or coverage miss is never reported as no route, and an incomplete contour is never presented as complete.

Device/server routes match status, distance, time, coordinates and OSM way sequence. Contour comparison checks exact GeoJSON for complete results on the same snapshot. Result metrics include profile, snapshot, compute time, fetched routing bytes and cell/cache information.

## Compilation and compatibility

Normal `generate` emits all three networks. To upgrade an existing archive while preserving display/search payloads:

```sh
bun run cli transport --input data/region.atlas --pbf data/region.osm.pbf --output data/region-transport.atlas
```

The compiler checks the PBF digest against the manifest, copies and verifies existing non-cell payloads, writes profile-specific cells, checks the complete file budget, then publishes by atomic rename. Source preprocessing/import remains regional and memory-based.

New cells use RCL2/RTE2 with directional seconds and turn relations. Old RCL1 walking cells and RTE1 reference graphs remain readable. There is no whole-graph fallback from a failed paged search. The legacy `routing-cells` command remains for adding RCL1 cells to older walking packages. The old whole-graph distance-only method rejects RTE2 so it cannot accidentally bypass travel-time/turn semantics.

Polygon-exported `.atlas` children still carry a clipped **walking-only RTE1** graph and omit transport/cell capabilities. They do not promise cycling/driving or isochrones. Whole-archive downloads and persistent cell caching retain those capabilities. Cell-aware portable offline extraction is a separate next step.

## Resource limits

The current kernel estimates a 32 MiB cell-cache budget, with 250,000 search records/reachable directed pieces and 1,000,000 queue entries. These limits do not bound total WASM RSS. The reader separately limits decoded routing payloads to 16 MiB. IndexedDB holds up to 128 MiB of compressed eligible blocks across snapshots, with hash verification and LRU eviction. Changing profiles clears the resident kernel graph; other modes remain available in persistent byte storage.

Long/dense searches may exceed the budget; shorten the route/time. There is no routing hierarchy or cross-package continuation. Extent boundaries and conservative access exclusions can truncate a reachable area. The server pins a read-only file descriptor and serializes operation requests. Routing has its own WASM facade. Cell codec/partitioning, decoded-cell residency and endpoint snapping are separate from search expansion; routes and isochrones still share the same cost/turn semantics. See [stack review](STACK-REVIEW.md) for completed measures and the remaining scaling work.
