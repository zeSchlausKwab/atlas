# Constructed geometry and continuous fields

Atlas chat can construct polygons and sampled spatial fields from cached map data.
This is client computation: no new archive format, data rebuild, spatial API or
server-side analysis is needed. Selected Atlas files supply the observed geometry;
the geometry engine supplies the derived shapes.

## Tool contract

| Tool | Input | Output |
| --- | --- | --- |
| `spatial_bands` | Cached geometry, increasing metre distances, optional clip bounds | Dissolved, disjoint Polygon/MultiPolygon bands with holes, labels, areas and distance endpoints |
| `spatial_shape` | Circle, rectangle, polygon rings, or cached lines plus corridor radius | Validated, drawable geometry result; authored/derived provenance |
| `field_create` | Cached geometry or points, bounds, sample spacing, method | Opaque field reference, units, range, resolution, sample memory and source provenance |
| `field_contours` | Field reference, new thresholds, `bands` or `lines` | Cached polygon bands or contour lines, ready for `map_draw` |
| `field_inspect` | Field reference | Descriptor and provenance, without returning samples to the model |
| `field_release` | Field reference | Releases sample memory; existing contour geometry remains usable |

Geometry results and numeric fields are different reference types. A field is not
GeoJSON: it must pass through `field_contours` before drawing. Field samples stay
in the browser analysis worker. New chat releases all fields and geometry results.
The model can restyle drawings or change thresholds without reopening the files.

### Bank-distance bands

Prepare water geometry over a padded region, select the intended river polygons,
then call:

```json
{
  "result": "<selected-water-result>",
  "distancesMeters": [100, 250, 500],
  "excludeSource": true,
  "bounds": [16.35, 48.20, 16.43, 48.25],
  "toleranceMeters": 2
}
```

`spatial_bands` buffers the full source objects, dissolves overlapping buffers,
subtracts each previous extent, then clips to the requested rectangle. Removing
water interiors leaves landward strips and islands instead of overlapping blue
squares. Including the source is optional. Lines measure from centerlines; polygon
bands measure from the mapped area. Filter deliberately rather than silently
combining both interpretations.

`toleranceMeters` controls round-join tessellation, not total geographic accuracy.
Buffers use Turf's per-feature azimuthal equidistant projection. Source precision,
projection distortion and input completeness remain separate limitations. Very
complex individual buffer/union calls cannot be cancelled mid-call; the worker
yields and checks cancellation between operations.

Source padding must be at least the largest requested distance. This tool does
not load missing neighboring objects automatically. Coverage provenance survives
into the result; a complete retained extract is not proof of real-world completeness.

The result properties `bandIndex`, `fromMeters`, `toMeters`, `label` and `areaM2`
can feed filters, summaries, charts and drawing styles. Existing `run_code` can
assign a palette per band, then `map_draw` binds `colorProperty` with a legend.

### Shapes

- Circle: resolved `[longitude, latitude]` center plus radius in metres.
- Rectangle: `[west,south,east,north]` bounds.
- Polygon: outer ring followed by optional holes; rings close automatically.
  Invalid coordinates, self-crossings, outside/overlapping holes are rejected.
- Corridor: cached LineString/MultiLineString result and `radiusMeters` as half-width.

The assistant must ground coordinates in source results or explicit user input.
Constructing a plausible polygon does not make it an observed boundary.

### Fields

The first methods are:

- **Distance:** nearest retained point, line segment or polygon. Polygon interiors
  are zero; holes are outside. Segment indexing avoids scanning every edge for
  every sample.
- **Density:** Gaussian kernel density of Point/MultiPoint observations. Requires
  `bandwidthMeters`; optional numeric weights and unit. A four-bandwidth cutoff
  omits about 0.034% of kernel mass. No boundary correction is applied. Missing
  weights are reported and excluded; negative weights are rejected. Use
  `spatial_points` explicitly when representative feature locations are intended.

Both use a local equirectangular metric on a spherical Earth, with reported
projection center and east–west scale variation. The implementation rejects
extents with more than 2% east–west scale variation or 20° longitude span instead
of presenting a local approximation as a global metric. This does not bound all
geometric error; use these fields for regional exploratory analysis.

Sample nodes include the bounds' edges. Actual spacing is at most `cellMeters`.
Contours use interpolated marching squares, not filled square cells. Narrow
features can be missed at coarse spacing. No silent coarsening occurs. Empty
sources produce unknown samples and no contours, rather than false zero values.
This slice does not implement interpolation of external measurements or terrain.

Changing `[0,100,250,500]` to `[0,150,350,700]` reuses the same field samples.
Filled bands use adjacent `[lower,upper)` intervals; values outside the endpoints
are omitted. Isolines do not include the rectangle's artificial closure edges.
Distance contour bands include zero-distance polygon interiors; use
`spatial_bands` with `excludeSource:true` for land-only bank proximity.

## Danube regression

The exported case from 2026-10-27 approximated proximity with 595 grid squares of
200 m. The deterministic regression selects the seven retained water polygons
from that case, prepares a padded area across both Vienna archives, and clips
outputs to `[16.35,48.20,16.43,48.25]`. The north boundary is kept within the pair
so padding fits. It checks polygon bounds, disjoint bands and zero extra reads.

On the development Mac, one run measured:

| Step | Time | Additional source bytes |
| --- | ---: | ---: |
| Prepare 172 retained water features | 75 ms | 721,009 |
| Three direct bank-distance bands | 2,080 ms | 0 |
| Distance field: 53,536 samples, ~25 m spacing | 848 ms | 0 |
| Filled contours | 135 ms | 0 |
| Different contour levels as lines | 8 ms | 0 |

These are local kernel measurements, excluding model latency. Field sample storage
was 428,288 bytes, excluding geometry, indexing and runtime overhead.

```sh
bun test tests/spatial-construction.test.ts tests/spatial-fields.test.ts tests/chat-fields.test.ts
bun run verify:continuous-pair
# Or specify your local copies:
bun run verify:continuous-pair path/to/west.atlas path/to/east.atlas
```

The verifier writes GeoJSON plus a compact report under `/tmp/atlas-danube-*` and
`/tmp/atlas-continuous-verification.json`. Browser verification uses a deterministic
model fixture with the real analysis worker, QuickJS style assignment, map drawing,
legend, JSON export and New chat cleanup; it does not call DeepSeek.

A proximity field is not a flood model. Flood depth and inundation require terrain,
water levels and hydraulic assumptions; defenses and drainage matter. Those inputs
are not supplied by these operations.

Implementation: [Turf buffer](https://turfjs.org/docs/api/buffer), polygon overlays,
and [D3 contours](https://d3js.org/d3-contour/contour), pinned dependencies. Fields
and geometry have no I/O; chat owns their lifetimes and provenance. HTTP/ContextVM
registration of these newer chat operations remains a separate integration.
