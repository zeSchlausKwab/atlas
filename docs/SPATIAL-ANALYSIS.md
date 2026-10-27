# Cached spatial analysis

The AI works with opaque result references. Source data is prepared once from the
selected Atlas files, deduplicated by the workspace, and retained on the device.
Spatial operations produce new result references; they do not modify the map
archive or fetch additional blocks. All results can be reused in later turns.

## Tools

| Tool | Output and interpretation |
| --- | --- |
| `spatial_measure` | Polygon `areaM2` and `perimeterM`; line `lengthM`. Perimeter includes hole boundaries. Non-applicable metrics are null. |
| `spatial_points` | One surface point per geometry, or explicit vertex-mean centroid. Keeps original attributes. A centroid can be outside the shape; neither is an entrance. |
| `spatial_buffer` | One approximate geographic buffer per input, in metres. Works on points, lines and polygons; overlaps remain until union. |
| `spatial_overlay` | Dissolved union, intersection or difference of polygon sets. Holes preserved; empty intersection returns an empty result. |
| `spatial_clip` | Cuts points, lines and polygons to a rectangle. Measure afterwards for totals inside that boundary. |
| `spatial_hull` | Convex hull of vertices. Includes gaps; not proof of coverage. Collinear/insufficient input produces no polygon. |
| `spatial_nearest` | Closest retained target geometry to each source representative point, within an explicit radius. Adds distance, target ID/name, match flag and closest coordinates. Optional connectors. |
| `spatial_filter` | Keeps whole source features intersecting targets, or whose representative point is within a target polygon. Can invert. Touching counts. |
| `spatial_join` | Per-source target match count/IDs, optionally numeric aggregates. Source and target direction matters. |
| `spatial_grid` | Approximate metre-sized geographic cells, count/density and optional numeric aggregates. One surface point assigns each feature exactly once. Includes empty cells. |
| `result_filter` | Attribute/ID filters, sorting and optional top N. Reports pre-limit matches. Supports derived metrics and dotted paths such as `tags.highway`. Requires geometry for the returned drawable result. |
| `result_summary` | Available fields/types, geometry-type counts and optional numeric statistics or category counts. Missing/non-numeric values remain explicit. |
| `feature_inspect` | One feature's attributes, identity, geometry type, bounds and provenance; no coordinate array in the model reply. |
| `chart_show` / `chart_remove` | Histograms, categorical bars, scatterplots and paged tables linked to cached geometry. |

`geometryType` can select Point/LineString/Polygon/etc in workspace queries and
result filters. On attribute-only non-location workspaces it is unknown; prepare
geometry for these analyses. Locations expose Point geometry from their retained
coordinates. Numeric OSM tag strings are not silently converted into measurements.

## Example: water proximity

1. Prepare `water` and `buildings` for the study rectangle with `geometry:true`.
2. Query each family into separate result references.
3. Buffer the water result by 100 metres.
4. Union the buffers to remove overlapping buffer area.
5. Filter buildings against that union using `intersects`.
6. Draw the original water and selected buildings with colors and a legend.
7. Summarize or chart building heights; keep unknowns distinct.

This measures proximity to retained water features. It does not model flooding,
terrain, bank access, water quality or walking routes.

## Charts and inspection

Click bars/table rows or brush a scatterplot to highlight the exact contributing
features. The scatterplot has an accessible table alternative. A zero numeric
value is retained; missing/non-numeric observations have a separate selection.
Use **Clear highlight** to remove chart selection, or **Remove chart** to remove a
plot. Cached result references remain available until New chat or page teardown.

Under **Drawings → Inspect drawings**, click a colored chat geometry. Its source
attributes, derived metrics and provenance appear in the chat panel. This mode
inspects chat overlays, not arbitrary basemap objects. Escape cancels inspection.
Layer ordering determines the topmost hit; polygon holes are respected.

Chart contents and selection indices stay on the device. Tool replies contain
metadata, counts, units and provenance. Export JSON captures current charts,
selection, inspection and drawing GeoJSON along with the existing full tool trace.
This is still an evaluation record rather than an importable saved session.

## Geometry and counting semantics

- Coordinates are longitude/latitude. Area, length and proximity use spherical
  calculations; polygon overlay uses GeoJSON coordinates. Buffers use a per-feature
  projection and 16 segments per quadrant. They are suitable for exploratory
  regional analysis, not survey-grade measurements. Split antimeridian-crossing
  geometry first; analysis bounds are within ±85° latitude.
- Nearest is from the source's representative surface point to the full target
  geometry, not centroid-to-centroid and not minimum footprint separation. A point
  inside a target polygon has zero distance; holes remain outside. Radius and
  missing target data affect matches. Unmatched means no retained match within
  the requested radius, not absence in the world.
- Grid cells approximate metre dimensions at the bounds' middle latitude. Density
  uses each cell's spherical area. Representative-point counts are not clipped
  line lengths, polygon coverage or population. Outside representatives are
  reported. Edge cells are clipped to the requested rectangle.
- Joins can count the same target in several overlapping source polygons. Area
  and length sums can double-count overlaps/parallel tracks. An OSM way is not
  necessarily a whole named road. Union polygons before claiming a dissolved area.
- Derived geometries retain source attributes; metrics calculated before a later
  geometry transformation still describe the earlier shape. Measure again after
  clipping/buffering if the new geometry is the subject of the measurement.
- Null numeric values do not become zero. Aggregates with no numeric observations
  have null sum/mean/min/max and explicit known/unknown counts. Empty grid cells
  have zero retained features; coverage remains independent evidence.

## Implementation and verification

`packages/spatial` contains a pure geometry engine with no readers/network access.
A bounding-box tree reduces pair tests for joins/proximity. The browser's chat
worker executes it and yields between batches so Stop can cancel. A single
polygon clipping/union kernel cannot currently be interrupted mid-call; very
large/complex polygons can delay cancellation. There is no new workload cap.

`packages/chat` normalizes workspace rows and GeoJSON results, retains provenance,
and prepares chart membership. Browser chart/inspection UI remains separate from
geometry computation. Existing QuickJS remains available for custom calculations,
classification and label formatting. The spatial tool adapter is exposed in
browser chat in this slice; host HTTP/ContextVM registration remains separate.

```sh
bun test tests/spatial-analysis.test.ts
bun run verify:spatial-pair
# Optionally supply the two Vienna rehearsal archive paths:
bun run verify:spatial-pair path/to/west.atlas path/to/east.atlas
```

The pair proof checks six families, clipped road length, water proximity,
nearest railway geometry, grids, chart membership, attribute inspection and zero
additional source reads. Geometry fixtures cover holes, boundary touches, nulls,
multilines, ties, radius cutoffs, hulls, clipping and cancellation.

Geometry primitives use modular [Turf](https://turfjs.org/docs/api/buffer)
packages pinned to 7.4.0; [nearestPointOnLine](https://turfjs.org/docs/api/nearestPointOnLine)
provides the spherical point-to-segment distance. No external spatial API is used.
