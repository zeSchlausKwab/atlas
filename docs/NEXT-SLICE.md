# Transport routing, reachability, and responsiveness

User request: isochrones and routing for different transport modes, followed by a stack/code-structure review and client performance work. Default modes: walking, cycling, driving. Keep native/WASM/client/server parity, on-demand cells, honest missing-data outcomes, and existing packages readable.

## Work plan

1. Capture a repeatable browser interaction baseline before renderer changes.
2. Compile profile-specific access/directions and estimated travel-time costs from the retained source PBF. Preserve existing map/search payloads when updating Vienna. Add common via-node turn restrictions where practical; disclose unsupported rules.
3. Extend the shared native routing core for time-weighted routes and bounded reachability. Reuse verified cell reads and resumable search. Produce approximate contour GeoJSON from the reachable network, not a radius or convex hull.
4. Add mode selection, time bands, origin picking, overlay/export, device/server comparison, and offline pause/resume to the demo. Verify synthetic transport rules and real Vienna behavior. Commit in coherent checkpoints.
5. Diagnose client latency against the captured baseline, fix measured bottlenecks, and rerun the same interaction workload.
6. Document the architecture review with current module boundaries, measured tradeoffs, and recommended next changes. Do not do an unrelated sweeping rewrite.

No public-transport timetable profile: the dataset has no GTFS service schedule. Travel times are modeled estimates, without traffic. Walking/cycling/driving must use their actual profile networks, not scale the walking graph.
