# Stack review after transport and isochrones

## What this slice establishes

A single archive can deliver different representations for different jobs. Rendering, routing by mode, source-object extraction, labels and search use independent blocks. Browser and server consume the same verified bytes and run the same operation engine. Isochrones reuse routing access/cost rules and its missing-data continuation rather than becoming a separate server product.

The strongest boundary is **immutable package → verified byte reader → operation core**. Keep it. Keep view styling and camera state independent of data selection. Native Rust is useful for validation, graph search, contour construction and geometry preparation, but putting code in WASM does not remove main-thread work or make an unsuitable algorithm efficient.

## Measured client responsiveness

Visible Chromium on this Mac, 1700 × 1050 viewport, fresh browser context, all normal geometry and place/street/POI labels enabled. Start with the Praterstern example; apply wheel deltas −480, +960, −720, each followed by a 90-step circular pan. Record requestAnimationFrame deltas and browser long tasks during the interactions. Cached panning alone was already approximately 60 fps.

| Cold interaction | Before p95 / maximum frame | After p95 / maximum frame | Long tasks before → after |
| ---------------- | -------------------------: | ------------------------: | ------------------------: |
| Zoom in + pan    |             17.7 / 50.0 ms |            17.3 / 18.6 ms |             1 (53 ms) → 0 |
| Zoom out + pan   |             17.6 / 17.7 ms |            17.5 / 18.4 ms |                     0 → 0 |
| Zoom in + pan    |             33.3 / 50.0 ms |            16.8 / 18.3 ms |                     0 → 0 |

A separate CPU profile of that workload showed roughly 4.67 s in label drawing/layout, including 1.84 s in `measureText`; cached tile-descriptor queries consumed about 1.03 s. Tile preparation/upload together accounted for roughly 0.16 s. Sampling overhead affects these totals; they diagnose relative cost, not production frame times. The instrumented repeat also reproduced a >50 ms stall.

Changes made:

- Cache text widths by font/text with a bounded entry count, and invalidate when fonts finish loading.
- Retain sorted label candidates until their block set changes. Cache projected road geometry; reject off-screen road bounds and POIs before expensive layout/text work.
- Compute ground camera transforms once per batch. Avoid altitude-conversion work when the point is on the ground.
- Look up small viewport/cell requests by exact address, instead of scanning every previously loaded descriptor on each frame. Broad explicit queries retain a scan fallback.

Visual content was not reduced. This is a small local before/after result, **not** a claim of parity with MapLibre/PMTiles. The visible CPU draw counter still measures GPU command submission, not GPU execution or total frame time. A controlled comparison needs identical geometry/detail, labels, viewport, device pixel ratio, pitch, cold/warm caches and interaction traces. Include p95/p99 frames, input latency, time to complete detail, transferred/decoded bytes and memory after a long pan.

## Code boundaries to improve

| Current seam                                                                          | Why it matters                                                                                         | Recommended next change                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/renderer` exports rendering and routing WASM bindings                         | A server operation imports a rendering-named artifact; independent worker/backend releases are awkward | Keep `atlas-routing` pure. Create small routing and render WASM facades over separate native cores. Preserve one tested operation contract.                                                                 |
| `packages/renderer/src/map.ts` owns input, scheduling, GPU lifetime and many overlays | At about 1,000 lines, changes in one behavior disturb unrelated presentation state                     | Extract camera/input, tile scheduler/cache and an overlay registry. Keep `AtlasMap` as the consumer facade. Existing `TilePresentation`, labels and feature-overlay modules are useful starting boundaries. |
| `apps/web/src/main.ts` and tool controls combine policy, DOM state and measurements   | Cancellation and profile changes span multiple controls sharing a worker                               | Introduce an operation controller with typed requests, cancellation and progress subscriptions. Keep separate route/reachability presentations; avoid adding more tool-specific callbacks to `AtlasMap`.    |
| `crates/routing/src/cells.rs` owns cell codec/cache, snapping and search              | Search correctness and byte-layout evolution are harder to review together                             | Split graph/cell serialization and profile costing from the search session. Keep route and reachability as two terminal policies over the same expansion semantics.                                         |
| Manifest has legacy walking metadata plus new transport metadata                      | This preserves readers but duplicates capability negotiation and export rules                          | Define a typed operation catalog with codec/schema versions, required block families, coverage and supported parameters. A requested capability should declare its dependencies.                            |
| Two importer entry points share walking policy via source paths                       | Useful prototype reuse, weak ownership for future conditions/vehicle classes                           | Move shared import/policy functions into an importer library; keep CLI binaries thin.                                                                                                                       |

These are proposed boundaries, not an instruction to rewrite everything at once. The transport tests and current browser behavior are the compatibility checkpoints.

## Scaling work, in order

1. **File-backed server and a complete cache budget.** The server currently materializes the entire archive in a Blob; range delivery should use a pinned read-only file descriptor and positional reads. Preserve snapshot consistency across path replacement. Bound decoded display bytes, directory descriptors, labels and prepared meshes independently. GPU tiles currently disappear as soon as they leave the retained view, causing repeat work when panning back.
2. **Renderer scheduling and labels.** Measure representative dense/cold/tilted views and active isochrones. A bounded mesh/label worker pipeline is the next candidate if preparation or placement again dominates. GPU text/label placement or retained overlay geometry should be justified by those measurements. Do not assume WebGPU alone solves CPU layout and cache churn.
3. **Routing hierarchy and explicit coverage.** Raw cell A\* is useful regionally; long routes and wide driving bands need partition overlays/shortcuts and compact spatial snapping indexes. Persist completeness/coverage information so results near an extract edge can say what was actually searched. Then support cell-aware offline extraction for all profiles.
4. **Paged semantic indexes.** Search names and reverse-street geometry still arrive as regional blocks; peak queries scan their block. Add independent text/spatial/aggregate indexes with bounded client execution. This is more valuable for a planet archive than polishing a monolithic query endpoint.
5. **Compiler streaming and authenticated transport.** Current import holds node maps and graphs in RAM and rereads the PBF per mode. Move to staged disk-backed construction before planet-scale generation. Hashtree/Nostr should supply discovery, authenticated roots and interchangeable block transport underneath the same reader—not change rendering or query APIs. Discovery/replication are not implemented by this slice.

Transport profile costs, conditional rules, slopes, turn delays and transit schedules are a separate accuracy roadmap. The current estimated times and conservative exclusions are deliberately visible in metadata/UI.

## Verification in this slice

Native tests exercise fastest-time paths, partial directional costs, mode validation, via-node/only/U-turn rules, missing-cell continuation and contour holes/nesting. Bun tests use the actual WASM and container readers, the server API, and a small real PBF fixture. The full Vienna upgrade validates all 15,676 cells and confirms the previous non-cell hashes. Visible browser flows cover three-mode route/contour parity, GeoJSON export, cached execution, mid-search pause/resume, actual disconnected reload and a 390 px layout.
