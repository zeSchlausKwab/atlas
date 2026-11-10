# Analysis source retention

Implemented 2026-10-28. This is an optional data capability inside one finished
`.atlas`, independent of rendering layers. It addresses the repeated problem of
retaining only objects that a map style knows how to display. It is not a claim
that OSM contains all real-world facts.

## What survives compilation

- Every tagged node encountered in the input PBF: benches, trees, entrances,
  barriers, crossings, stops, amenities, addresses, infrastructure and unfamiliar
  tags. The importer no longer needs a renderer category for these objects.
- Every way, its tags, ordered OSM node references and whole geometry. Untagged
  ways remain addressable dependencies but are excluded from normal search.
- Every relation, its original identity, tags and ordered member roles. Complete
  supported multipolygons/boundaries get geometry, including holes and islands.
  Other relations retain membership without inventing a polygon or a route.
- Administrative/national boundaries, protected areas and physical coastline
  ways. Explicit `subarea`, `admin_centre` and other relationships are retained.
  Numeric admin levels do not establish hierarchy or resolve disputed borders.
- Hospitals, campuses, parks, industrial sites and similar closed areas retain
  footprints when their tags establish area semantics. Unknown closed ways stay
  lines; `area=no` and coastline are never closed into guessed areas.

Selection retains whole intersecting objects. Unlocated relation/incomplete
object metadata is retained conservatively; a member reference may point outside
the excerpt. Relation node members can embed coordinates even when their node
is not separately tagged. Missing source members, missing nodes and incomplete
area assembly are reported explicitly. Untagged coordinate nodes are represented
by way coordinates/references, not millions of separate point records. Original
OSM per-object versions/timestamps are not retained; the PBF snapshot is hashed.

The existing specialized families still coexist with this generic store. This
duplicates some geometry when both are selected. The generic store itself writes
each identity once. An **Analysis** preset selects objects, administrative areas
and search, without implicitly selecting display or routing. **All capabilities**
includes the generic store.

## Tools and local execution

| Tool                                            | Purpose                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `source_catalog`                                | Retained counts, tag keys, geometry status, omissions and provenance without loading shapes            |
| `object_search`                                 | Find tags, names or facets across selected maps; bounds are optional and never implicitly the viewport |
| `object_get`                                    | Fetch one exact object's geometry; chat receives a local result reference for drawing/analysis         |
| `object_members`                                | Page through ordered members with retained/reference-only/missing-source availability                  |
| `workspace_prepare` with `families:["objects"]` | Prepare complete bounded analysis; apply `where` tag predicates before geometry loading                |

The same implementations are registered for device, server and ContextVM.
Metadata pages carry bounding boxes and tag-key summaries. Exact tag values are
checked before reading geometry. Boundary-crossing candidates still need shape
reads for an exact spatial test. Prepared workspaces can run repeated queries
without further source reads. Runtime geometry is not sent through model tokens.

The host library exposes a Source retention report. Old archives report that the
capability was not retained; a client update cannot recover omitted source data.

## Coast, sea and global geometry

PBF coastlines are retained as physical directed lines. An incomplete regional
coastline does not prove a closed sea polygon. The normal partitioned compiler, when a pinned ocean source is selected,
stores assembled **sea polygons** as queryable external objects as well as
display tiles. They preserve holes and source hashes; provider/clipping edges
are labelled artificial and must not be mistaken for physical coasts.

The generic reader supports split antimeridian extents and polar coordinates.
Tests cover a dateline-crossing line, a query that must not hit Greenwich, and a
point at 89°N. This does **not** make the Mercator renderer or current regional
spatial operators spherical: polar-cap polygons, global buffering and shipping
pathfinding still need explicit global algorithms. No automatic global land
complement or navigable ocean graph is produced by this slice.

## Rebuild or upgrade

Choose **Analysis source** when preparing a PBF. Existing Atlas excerpts can
retain it only when their parent already has the capability. For a same-snapshot
upgrade, compile an object/boundary-only archive covering the old map, then:

```sh
bun scripts/upgrade-source-objects.ts original.atlas objects.atlas upgraded.atlas
```

The source PBF hash and coverage must match. This writes a new self-contained
archive and preserves compressed display/routing/search blocks. Routing graph
identity survives the new archive snapshot. Nothing overwrites the original.
Cached blocks remain keyed to their immutable snapshots.

## Measurements and acceptance

Reproduce with `bun scripts/benchmark-source-objects.ts` using the existing local
Monaco and Vienna PBFs. Measurements below are local-file runs on the development
Mac; they are not predictions for HTTP or continent-size builds. Archives here
contain objects and administrative boundaries, not display/routing/search.

| Input                          | Retained objects | Analysis archive | Build time | Attribute query                                    |
| ------------------------------ | ---------------: | ---------------: | ---------: | -------------------------------------------------- |
| Monaco, 0.66 MiB PBF           |           10,842 |         3.55 MiB |      5.5 s | 24 coastline ways, 418 KiB additional reads, 26 ms |
| Vienna rehearsal, 23.9 MiB PBF |          574,830 |        155.0 MiB |      253 s | 16,235 benches, 19.7 MiB additional reads, 1.25 s  |

The catalog is already read before the measured query. No shape payloads are
read for those attribute searches. A following, smaller Vienna geometry query
returned 1,518 bench points with 11.1 MiB additional reads in 681 ms (partly warm
metadata). These are the original v1 measurements. The v2 packing and exact-value index
below address that overhead; they do not silently truncate results.

`bun scripts/verify-source-objects.ts` exercises an OSM XML→PBF→native importer→
archive→local workspace pipeline. Unit regressions cover selective reads, holes,
relationships, cross-source parity, cancellation, malformed payload references,
self-contained excerpts, dateline/polar cases and ocean patching. Existing
boundary, routing, rendering, geocoding and archive tests remain applicable.

## Next data sources, rather than guessed facts

Retaining generic tags makes new operations possible without rebuilding for each
new tool. It cannot supply missing measurements. Additional families still needed
for their respective use cases include elevation/terrain and bathymetry rasters,
population/demographics, time zones, official hazards and water levels, schedules,
live conditions, legal marine boundaries and navigation constraints. Their
contracts need units, CRS, timestamp/validity, provenance, missing-value semantics
and coverage. Until then, the AI must report unavailable data.

For shipping, retained ferry/routes/harbour/seamark tags are useful evidence, not
a global navigation service. Future routing needs connected water topology,
ports, depth/draft, restrictions and appropriate time-dependent data.

## Local rehearsal

The current development files are `data/pair-rehearsal/west-packed.atlas`
(180,257,567 bytes) and `east-packed.atlas` (115,338,158 bytes), with 371,010 and
252,825 source objects respectively. The old `*-analysis.atlas` files are retained.
Routing, address search, display and administrative data survive unchanged.
Generated archives are not committed.

```sh
bun run build:client
bun scripts/serve-analysis-demo.ts data/pair-rehearsal/west-packed.atlas data/pair-rehearsal/east-packed.atlas
# In another terminal, if the client is not already running:
bun run client
```

The script prints a chat link and exposes only loopback map data/operations. It
uses the production range/API implementations and accepts alternative `.atlas`
paths as arguments. `ATLAS_REHEARSAL_PORT` changes its default 5175 port. No LAN
service or existing catalog is modified. Map computation remains local to the
client when the AI uses its default tools.

## Prompts for the upgraded rehearsal pair

- “While I am looking at Schönbrunn, find the Prater park footprint. Show mapped
  benches inside it, separate points outside the selected data coverage, and
  draw 50-metre walking-proximity circles around them. Call these straight-line
  proximity circles, not walking isochrones.”
- “Find hospital grounds in the selected maps. Draw their retained footprints,
  place mapped entrances on them, and colour entrances with explicit access
  restrictions separately from entrances whose access is unknown.”
- “Build a green corridor from retained parks and wetlands: buffer their polygons
  by 100 metres, dissolve overlaps, subtract water, and show which gaps remain.
  Explain that geometric adjacency does not establish a walkable connection.”
- “On the Monaco sample, draw physical coastline in orange. If queryable sea
  polygons are present, fill them blue without treating their rectangular split
  edges as coastline. Report which source each layer came from.”

## Packed source objects and exact-value lookup (2026-10-28)

New builds write `source-objects-v2`. Small geometry and topology payloads share
64 KiB blocks with validated byte offsets; large payloads retain 1 MiB chunks.
Attributes remain separate. A sorted exact tag key/value index leads to bounded
posting pages, then the existing spatial/attribute checks. Short posting lists
store only record-page keys, avoiding a large repeated envelope for every unique
name/address. v1 files remain readable; v2 readers do not need a runtime server.

Measured on identical local inputs, with identical query IDs and object counts:

| Measurement                                                   |          Original |   Packed/indexed |
| ------------------------------------------------------------- | ----------------: | ---------------: |
| Vienna analysis archive (574,830 objects)                     |         162.54 MB |        114.51 MB |
| Vienna exact `amenity=bench` reads (16,235 IDs)               |          20.62 MB |         0.619 MB |
| Same query, local elapsed time                                |          1,379 ms |            77 ms |
| Subsequent smaller geometry query (1,518 points; partly warm) | 11.59 MB / 714 ms | 0.127 MB / 30 ms |
| Monaco analysis archive (10,842 objects)                      |           3.72 MB |          2.26 MB |

These are local file measurements, not continent-wide or LAN latency promises.
The compiler stages attributes, tag postings and payloads in disposable SQLite
inside the build workspace. Directory assembly is disk-backed; some page summaries
and excerpt planning still consume memory proportional to the selected index.

```sh
bun scripts/repack-source-objects.ts OLD.atlas NEW.atlas
bun scripts/benchmark-packed-objects.ts vienna OLD.atlas NEW.atlas
bun scripts/verify-chat-pair.ts data/pair-rehearsal/west-packed.atlas data/pair-rehearsal/east-packed.atlas
```

Repacking does not invent absent tags/relations. An archive without generic source
objects needs rebuilding from the existing cached PBF (or upgrading from a matching
analysis archive). **No source PBF redownload is needed.** Consumers reopen the new
snapshot; online clients fetch needed ranges, while offline users replace their
saved archives. Old snapshot caches are not mixed with new ones.
