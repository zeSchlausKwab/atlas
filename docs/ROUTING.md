# Walking routing prototype

OSM PBF → topology → independently hashed routing cells in one `.atlas` file → HTTP ranges or local file → resumable Rust/WASM A\*. Display tiles and routing cells are separate representations. The same engine runs in a browser worker and on the Bun server.

## Try the routing-cell demo

The current Vienna Plus package has 5,542 z14 routing cells. Reload the app, choose **Route**, and leave **Run tools on → This device** selected.

1. Choose **Try Stephansplatz → Praterstern**. Only the cells needed for snapping and search load.
2. Enable **Cache only**, then **Reverse**: the route reuses cached cells.
3. Choose **Try Stephansplatz → Schönbrunn**. With a fresh cache this pauses at missing coverage, shown in red. If previously visited, it may already be cached.
4. Choose **Fetch missing cells & resume** to enable reads and continue the existing search frontier.
5. Choose **Compare device & server**: the same snapshot produces matching route distance, coordinates and OSM way sequence.
6. After the app shell is saved and map loading finishes, disconnect and reload. Viewed map blocks and routing cells are reused from IndexedDB.

Select A and B yourself, or use search results as endpoints. Dragging pans; Enter chooses the center during picking; Escape cancels. Clear cancels the worker. Routing works independently of map zoom and can succeed while display coverage is partial.

## Measured on Vienna Plus

Snapshot `f54574974b952b7d7440e5e6c520e30f589d1345a84d29b613d89cf6153d2f86`:

| Route, in order                                   |    Distance |     Routing payload read | Cells used / reused |
| ------------------------------------------------- | ----------: | -----------------------: | ------------------: |
| Stephansplatz → Praterstern, cold                 | 2,062.523 m |            462,553 bytes |               3 / 0 |
| Stephansplatz → Schönbrunn, after the first route | 5,910.583 m | 906,697 additional bytes |               9 / 2 |
| Schönbrunn → Stephansplatz                        | 5,910.583 m |                  0 bytes |               8 / 8 |

The reference graph costs 69,445,864 compressed bytes. The first example reads about 99.3% less routing payload. Counts exclude directory pages and map tiles, which the inspector reports separately. These measurements are route-specific, not general throughput guarantees. Native search may explore well beyond the straight line between endpoints.

The visible-browser test also confirmed a zero-network offline reload and a matching 5.91 km server result with an 11.2 KB response. Reproduce distance/status comparisons with `bun scripts/check-routing-cells.ts`; it explicitly loads the whole reference graph for validation.

## Generation and compatibility

`generate` emits cells automatically for nonempty walking graphs. To add them to an existing package without repeating PBF import or tile generation:

```sh
bun run cli routing-cells --input data/region.atlas --output data/region-cells.atlas
```

The migration verifies and copies existing payloads, preserving compressed blocks and optionally compressing legacy raw blocks. It appends cell payloads plus directory leaves. All 348,408 previous Vienna payload hashes remain unchanged. Vienna grows from 640.1 MB to 725.3 MB. It retains `routing/walking` for reference comparison and the existing polygon exporter. Old packages and clipped offline children still use the reference graph; there is no silent fallback from a failed paged search to a whole-graph download.

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

1. Request the cells intersecting each endpoint's 150 m snap neighborhood. Scan those cells for the nearest eligible segment using the same local projection and original global segment-order tie breaking as the reference engine.
2. Create direction-sensitive partial endpoint connections. Actual node endpoints can use every incident edge. Same-segment routes retain their permitted partial distance.
3. Run A\* with spherical edge lengths and an admissible remaining-distance estimate. Expand each node using its owner cell, which contains all incident segments. Original OSM node IDs connect cells; geometric crossings never create junctions.
4. If a required cell is absent, return `NeedBlocks` without discarding the frontier or predecessor chain. Load and verify it, then continue. Search records retain reconstruction coordinates even after a decoded cell is evicted.
5. Return `found`, `no-route`, `unsnappable`, `missing-data`, or `budget-exceeded`, pinned to the snapshot. Missing bytes and exhausted memory budgets never become `no-route`. Malformed or corrupt data remains an error.

`no-route` requires exhausting the search within the retained graph. A legitimate route could leave the extract, use excluded ways, or require a different snap candidate. There is no authoritative completeness polygon or neighboring-package continuation yet.

Route distance excludes dotted snap offsets, whose walkability is unknown. Walking time is distance / 4.8 km/h without terrain, surfaces or obstacles. Cell metrics show cumulative routing payload fetched during that search, cells used/reused, estimated engine memory, and WASM search/load time; they exclude network and storage waiting. The generic operation timer includes waiting.

## Caches and limits

- The browser worker owns the resumable search. The server uses the same WASM class and orchestrator, yielding between bounded batches. Server reads never populate the client's cache.
- The engine limits estimated decoded-cell storage to 32 MiB, search records to 250,000 and queued entries to 1,000,000. Endpoint snap neighborhoods are temporarily pinned; if they cannot fit, the result is `budget-exceeded`. This is not a measurement or bound on total WASM/browser RSS.
- The reader bounds decoded routing bytes separately at 16 MiB. Other in-memory readers, rendering caches, label catalogs and search indexes remain regional prototypes.
- IndexedDB retains up to 128 MiB of compressed display/label blocks, directory leaves and routing cells across snapshots, using LRU eviction. Keys include snapshot, block key and hash. Every persisted hit is hash-checked before decode. Saved header/root metadata lets the app reopen the last validated snapshot when the network is unavailable; it then enters Cache only.
- The app shell uses a service worker. Browser storage can be evicted or denied; the UI reports a memory-only fallback when persistence fails. Search, query, extraction and reference-graph blocks are not persisted by this cache. Explicit `.atlas` exports remain the portable offline option.
- Polygon exports still read and clip the reference graph and omit inherited cell metadata. Cell-aware export is future work.
- No routing hierarchy or precomputed shortcuts yet. Long or dense regional searches can hit the budget. Dateline-spanning segments and segments covering more than 4,096 cells are rejected by this prototype compiler. Import and partitioning still hold the regional reference graph in memory. The server still pins the entire selected package in memory at startup.
- No driving/cycling/wheelchair profiles, turn restrictions, maneuver instructions, elevation/difficulty costs, live closures, conditional evaluation, ferries or relation-based networks.

Native tests cover crossing-cell detours, resumable missing reads, one-way snapping, disconnected crossings, bounded eviction/reconstruction, budget exhaustion and cell corruption. Bun tests exercise the actual WASM through package reads and the server API, including offline persistence, snapshot isolation, capability guards and malformed metadata. A visible Chromium flow verifies pause/resume, client/server parity, actual offline reload and narrow layouts; a separate browser check validates real IndexedDB LRU eviction and reopening.
