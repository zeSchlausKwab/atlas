# Three-map stress-test demo

The versioned recipe is `recipes/europe-three-map-demo.json`. Bounds are an
approximation of the requested screenshot. The variable edge is **east**, initially
27°E; the other edges are −15°W, 34°N and 65°N.

| Map            | Bounds W/S/E/N     | Purpose                                       |
| -------------- | ------------------ | --------------------------------------------- |
| Western Europe | −15 / 34 / 27 / 65 | Large AI, geographic and navigation workload  |
| Rhine–Alps     | 1.5 / 44 / 11 / 54 | Western half of composed test                 |
| Alps–Danube    | 9 / 44 / 20 / 51   | Eastern half: Vienna, Bratislava and Budapest |

The two smaller maps overlap between 9–11°E and both overlap the large map.
They are derived from the completed large archive, preserving its routing graph
identity. Each is a complete standalone file; neither needs the parent at runtime.
Disable the large source when testing cross-map routing on the smaller pair.

All use z0–16, walking/cycling/driving graphs, address/location search, nearest
street lookup, peak queries, labels, extractable geometries, administrative/national
boundaries, generic tags and ordered relation members, and assembled sea surfaces.
Unmapped or incomplete OSM objects remain explicitly incomplete; this does not add
DEM, bathymetry, official hazards, live data, or a global shipping graph.

## Size and storage

200 GB (decimal) is a **soft total final-file target**, tentatively 140 + 30 + 30 GB.
Actual size depends on source density and compression. Recipe `maxBytes` values
are hard ceilings (220 / 60 / 60 GB), not size predictions or padding targets.
Measure the first result before adjusting the east edge/child extents. Temporary
compiler stages can exceed final archive size. The live free-space guard retains
10 GiB plus a 2 GiB stopping margin; failed/cancelled cached builds keep checkpoints.

The verified planet stays on the NAS. SQLite, temporary stages and served maps use
the SSD. The source snapshot is reused: no new planet download is required. The
coastline ZIP is a separately fingerprinted October 11 source, while the cached
planet snapshot is October 5.

## Queue overnight

From the server release directory (default is a dry run):

```sh
bun scripts/queue-europe-demo.ts --server=http://127.0.0.1:3100
bun scripts/queue-europe-demo.ts --server=http://127.0.0.1:3100 --queue --receipt=/home/nixuser/atlas/shared/recipes/europe-three-map-receipt.json
```

Use `--east=27` to change the large eastern edge (20–35°E, still enclosing the
children). A saved receipt prevents duplicate submissions on a normal rerun.
If a submission's outcome is unknown after a connection failure, inspect `/host`
before retrying. Each job is recorded on disk. The child jobs wait until the parent
is published; then they run in order. Queued jobs survive a server restart, while
an interrupted active build requires explicit resume. Remove a queued job with
its queue button; stopping a running cached-PBF job keeps its checkpoints.

The host form can enqueue more preparations while another runs. Source downloads
have their own persistent queue and continue independently of the compiler queue.
Only one compiler runs at a time (it still uses the configured native worker pool).
Deployments refuse to switch code while preparations are running or queued.
The source-download worker keeps its pinned bundled implementation across deployment.

## Acceptance before using the large results

Check all three ready manifests and actual sizes, shared `graphSnapshot`, retention
reports, address search and cross-seam walking/cycling/driving. Query named areas
away from the viewport, municipal/national polygons, physical coastlines, sea
surfaces with island holes, and exact-tag point features. Repeat analysis from cache
and verify no extra source reads. Local Vienna regressions cover these code paths;
large-map performance still needs measurement after the builds finish.
