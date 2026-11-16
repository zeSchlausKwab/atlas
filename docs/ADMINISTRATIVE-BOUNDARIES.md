# Administrative areas inside Atlas

Implemented 28 October 2026. Administrative geometry is a selectable data family,
`boundaries`, stored in the same `.atlas` as display tiles, routing, search, and
other source features. No runtime boundary server or sidecar is required.

## What changed

The importer previously retained named place points but ignored OSM `type=boundary`
relations. A place point establishes a label location, not the extent of a district.
The importer now assembles `boundary=administrative` ways and relations with
`type=boundary` or `type=multipolygon`. Split/reversed ways, holes and detached
islands follow the existing area assembler. Incomplete rings are skipped, never
closed with invented lines. The compiler reports skipped area relations.

Select **Administrative areas · countries, municipalities & districts** under
extractable source features in the host UI. PBF extraction requests complete
boundary relations with osmium's smart strategy; this can pull source members
outside the selected area. Excerpt creation retains whole intersecting polygons,
including the parts outside the package's coverage. It does not claim that other
data outside that coverage is present.

All retained tags survive, including `admin_level`, multilingual names, references
and Wikidata links when mapped. Explicit `label` and `admin_centre` member links
are retained. `subarea` members are not polygon rings and are not assembled into
the parent's geometry.

## Tools and client behavior

- `boundary_search({query:"Innere Stadt", adminLevel:"9"})` searches administrative
  names in selected maps independently of the viewport. It returns candidates
  with exact OSM identities and administrative tags.
- `place_geometry({result, id:"relation/1990592", family:"boundaries"})` resolves
  the chosen candidate to its polygon in the client result store. That reference
  works with drawing, spatial filtering, intersection and statistics tools.
- `boundary_lookup({point:[16.3738,48.2082]})` finds retained areas containing a
  point, respecting holes and islands. It returns geometry plus coverage metadata.
- `workspace_prepare` accepts `families:["boundaries"]` with the same attribute
  predicates, geometry option, caches and byte accounting as other families.

Boundary search and containment use the same implementation on the client and
through the server operation registry (HTTP/ContextVM). The browser keeps geometry
locally behind result references rather than sending coordinate arrays to the
model. Overlapping sources deduplicate identities and reject conflicting records.

The AI must resolve ambiguous names, distinguish a cadastral area from an
administrative district, and ask before substituting an approximate area. A missing
polygon is reported as missing, not reconstructed from streets or place labels.

## Storage and selective reads

`boundaries/index` contains a compact page catalog. Each metadata page holds at
most 256 records / 1 MiB decoded, including bounding boxes and links to geometry.
Each boundary geometry is stored once per archive, rather than being copied into
every intersecting map tile or source cell. The standard paged archive directory
indexes these blocks. Geometry loads only for requested objects or exact spatial
intersection/containment checks. Exact boundary reads count as source-feature reads.

This first version scans retained boundary metadata for a name search. Page
bounding boxes prune spatial queries; it is not yet a global inverted name index
or a country-aware administrative hierarchy. Very large individual geometries
remain subject to the format's feature/block validation limits.

## Automatic border display (16 November 2026)

The classic viewer now draws administrative outlines independently of exact
analysis geometry. Sources with `boundary-rendering` expose an **Administrative
borders** checkbox, saved with composition links. Countries appear from z0,
levels 3–4 from z3, 5–6 from z5, 7–8 from z8, and finer levels from z10. These
are display thresholds, not a claim that administrative levels mean the same
thing in every country. Country outlines are solid; smaller areas are dashed.
The shared renderer opts in explicitly, so existing napplet/native consumer
resource choices do not change automatically.

`boundary-display/index` lists spatially grouped pages by administrative level.
`boundary-display/16/x/y` uses virtual page addresses, like the exact boundary
store; its page envelopes carry geographic coverage. Pages contain simplified
outline fragments with original source IDs. Holes and islands remain outlines.
Long rings are split with shared endpoints; date-line jumps do not draw a line
across the world. Display simplification is measured in Mercator screen units;
it does not jointly simplify shared edges and is unsuitable as analysis geometry.

Each page is limited to 64 fragments and 1 MiB decoded; the root is limited to
16 MiB. The renderer loads only visible levels/pages, with two concurrent reads
and a bounded display cache: 24 MiB for small views, scaled with viewport area
up to 96 MiB for large desktop views. It reports an explicit error
rather than silently dropping geometry if that budget is exceeded. Border reads
are counted as **map geometry**, including through the normal verified Hashtree
reader; exact `boundaries/` reads remain feature/analysis reads. Source precedence
and coverage clipping apply independently to borders.

The live canvas cache further simplifies these display outlines to the current
screen scale (half a pixel or less) and clips strokes to a buffered viewport
in Mercator coordinates. Zoom changes and movement outside that buffer rebuild
the cache from verified display blocks, restoring available detail without
touching exact analysis geometry. This prevents regional views from retaining
invisible close-up vertices and far-away outlines from intersecting pages.
Cached vertices use packed Float64 world coordinates, avoiding a JavaScript array
per vertex and repeated projection on each draw frame; the cache budget
accounts for buffer lengths and container overhead.
Regressions cover the memory failure, zoom refinement, panning and clipping
without joining disconnected strokes.

New boundary builds also produce display pages. To amend an existing archive
without another PBF scan:

```sh
bun scripts/add-border-display.ts existing.atlas new-with-borders.atlas
```

This creates a new immutable snapshot, reuses every existing payload with the
same hash, and preserves the exact polygons, tags and OSM source fingerprint.
Republish the new snapshot; existing pinned links keep pointing to the old one.

A low-zoom OSM overview can also be extracted from an already compiled OSM world
archive, retaining country polygons, places and land/water display levels 0–4:

```sh
bun scripts/derive-osm-overview.ts world.atlas overview.atlas
```

This still needs to scan the existing boundary metadata and copy selected
geometry; it does not read the planet PBF. Coastline provenance remains whatever
the source archive declares, including a separate OSM coastline snapshot.
`tests/border-display.test.ts` verifies selective display reads, source/hash
preservation, date-line handling, validation, composition and disposal behavior.

### World archive verification, 16 November 2026

The existing OSM world visualization retained 761,971 administrative polygons,
including 258 level-2 objects (not a count of sovereign countries). Adding border
display reused that geometry and every existing payload; it did not read the
planet again. The new immutable archive is 6,023,689,616 bytes. This first display
index is not yet a compact multi-resolution shared-edge representation.

Deriving the country-level OSM overview from the original world archive took
36 seconds, with approximately 530 MiB peak memory, and produced 114,927,016
bytes. Those measurements cover reuse of an already compiled archive, not a
fresh planet import. The retained source fingerprint and separate coastline
provenance remain in both manifests.

Live HTTP browser checks covered country outlines at z0, regional outlines over
central Europe at z5, local areas at z8, and panning beyond the cached viewport,
including narrow and desktop layouts.
The final suite passed 540 tests, with four environment-dependent checks skipped;
TypeScript and client builds also passed. Native/FIPS client rendering was not
retested for this opt-in display extension.

## Upgrade existing archives

Updating the client cannot recover geometry missing from old files. Either prepare
a new map with the family enabled, or compile a boundary-only archive from the
**same source snapshot**, covering the target area, and append it while copying
existing blocks:

```sh
bun scripts/upgrade-boundaries.ts old.atlas boundaries.atlas with-boundaries.atlas
```

The upgrader requires a new output path, verifies stored block hashes, preserves
existing compressed or raw payloads, and keeps routing graph identity. It rebuilds
the package directory and adds boundary blocks. The result is still one file.
It rejects a different source snapshot or insufficient boundary-source coverage.
Keep enough disk space for the new archive; the original is left intact. Interrupts
abort the new copy, which can be retried from the original.

The package snapshot and Hashtree root change. Publish it at a new immutable URL;
old files, references and announcements continue to identify their original data.
Old archives do not advertise this capability merely because the reader supports it.

Compiler checkpoint version 6 invalidates older source/semantic stages while
reusing matching, hash-verified transport and display artifacts. The source store
uses a new checkpoint identity and filename; interrupted old databases are not
silently treated as containing boundaries.

## Verification and current demo

`bun scripts/verify-boundaries.ts` exercises a real PBF through both importers and
the partitioned compiler: split/reversed rings, a hole, a detached island, explicit
place links, subarea handling, legacy administrative ways/multipolygons and an
incomplete relation. `tests/boundaries.test.ts` covers metadata paging, exact hole
intersection, attribute-only reads, offline reuse, overlapping sources, extraction,
client/server parity and immutable upgrades.

The Vienna rehearsal pair was upgraded from its existing PBF. It contains district
`relation/1990592` **Innere Stadt** (`admin_level=9`) and separately
`relation/5264583` **Katastralgemeinde Innere Stadt**. Both are returned by an
unqualified name search; they must not be silently conflated. Stephansdom is inside
the district geometry. Existing address search, the 3,260-building test area, and
cross-package walking/cycling/driving routes pass on the upgraded pair.

The larger Central Europe archives were compiled before this addition. They need
a boundary-only source pass and an upgrade (or a new preparation); the Vienna
boundary archive does not cover their extent and cannot be used for that upgrade.

## Published Vienna demo

The upgraded pair is available in the LAN host library as **Vienna west ·
administrative areas** and **Vienna east · administrative areas**. Open the local
client with the two new immutable IDs:

[Open the boundary demo](http://127.0.0.1:5173/?server=http%3A%2F%2F192.168.0.179%3A3100%2F&maps=dd5f7e19-f01e-4a31-bf44-f8a7dfd59ca9,ab55a3ca-206e-47d1-acad-02c29fcdf00d#tab=chat).

West retains 34 areas (+73,569 bytes); east retains 13 (+28,435 bytes), with
identity deduplication across the overlap. These counts describe this regional
PBF's retained complete polygons, not all administrative ancestors of Vienna.

A browser check on 28 October searched for the level-9 district, fetched its
geometry, styled and drew the exact polygon with a label: **11.8 KB** of chat
source reads, **11.3 seconds** including six model rounds, no browser errors.
This is one warm-LAN demonstration, not a performance guarantee. Server
`boundary_lookup` also returned byte-equivalent geometry through HTTP.

Try: “Draw the administrative district Innere Stadt in Vienna in purple, with a
label. Use its actual retained boundary and identify the OSM relation.”
Then: “Count mapped cafés inside that polygon and show them; report data coverage.”

## Important remaining data gaps

1. **Administrative hierarchy and address context.** Point containment is now
   available; country-specific meanings of `admin_level`, parent/child relationships,
   postal boundaries and municipality-aware address disambiguation are not inferred.
   They need explicit modeling and country-specific fixtures.
2. **Semantic indexes for broad queries.** Retained categories/tags can be queried
   locally, but large requests such as “all schools in this province” need category
   and spatial indexes so preparation avoids scanning irrelevant records. The
   capability contract must distinguish missing source features from no matches.
3. **Access and address detail.** Explicit mapped addresses exist. Interpolated
   address ranges, entrance selection, indoor access, and complete wheelchair or
   delivery constraints are not guaranteed by a routable road graph.
4. **Terrain, live transport and modeled risks.** Elevation surfaces, transit
   timetables, traffic and flood models require their own source data and semantics.
   A river buffer remains a proximity calculation, not a flood-risk model.

Every tool continues to report retained-source scope and unknown real-world
completeness. Adding polygons does not turn an OSM extract into an authoritative
administrative register.
