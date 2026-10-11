# Partitioned compiler and paged semantic data

The compiler keeps the existing `.atlas` container, tile codec and RCL2 routing
contract. New semantic schemas are additive. Current readers accept both the
regional schemas and these paged schemas. Older clients need an update to read
the new semantic roots; geometry and routing codecs are unchanged.

## Graph construction

`transport-partitioned` first scans routing references and restrictions into a
file-backed node-membership bitmap and SQLite. It then retains only coordinates
referenced by at least one transport mode. Coordinates are sorted into 4 KiB
pages (240 × 17-byte records plus padding), with an in-memory fence key per page.
A lookup searches the resident fences and touches one coordinate page, avoiding
a binary search across a continent-sized mapping. The fence costs 8 bytes per
240 retained nodes; the membership bitmap is capped at 4 GiB. Input must have
non-negative node IDs and the usual nodes/ways/relations type order.

Each profile spools edges in SQLite, then converts them to compressed cells and
reuses the edge pages before the next profile. Segment ordinals follow the canonical source way/node
order, independent of spatial partitioning. Node IDs join cells and ordinals
remove overlap duplicates. Costs retain f64 precision until the codec's upward
f32 rounding. All supported directions, barriers and via-node restrictions use
the same import rules as the regional compiler.

Graph cells have the existing 200,000-node, 300,000-segment, 50,000-turn limits.
A segment may touch at most 4,096 cells and its global ordinal must fit u32.
Unsupported conditional/via-way restrictions continue to exclude incoming ways
and are counted. This is not a navigation-grade restrictions model.

## Search and nearest street

- `search/locations`: `{schema:"locations-paged-v1",records,pages,names:true}`.
- `search/records/16/x/y`: ordinal pages of at most 256 records.
- `search/terms/8/x/y`: hashed n-gram term catalogs. Terms remain in
  the catalog, so hash collisions do not mix postings.
- `search/postings/16/x/y`: sorted record ordinals, 4,096 per page.
- `search/locations-data/14/x/y`: geographic copies for polygon export.
- `search/streets`: `{schema:"streets-paged-v1",streets,zoom:14}`.
- `search/streets-data/14/x/y`: full street fragments intersecting a cell.

Ordinal page addresses densely pack 32×32 directory leaves. For page ordinal p:
`leaf=floor(p/1024)`, `slot=p%1024`,
`x=(leaf%2048)*32+floor(slot/32)`, `y=floor(leaf/2048)*32+slot%32`.

The text index includes normalized name, aliases and settlement context, plus
name-only grams (`n:`) for single-token searches. Consumers fetch the rarest
postings and necessary record pages. Broad multiword queries intersect up to
four sorted posting streams. Ranking matches the regional geocoder. Exceeding
50,000 candidate records or 64 MiB of decoded query payload asks the user to
refine the query; it does not silently return incomplete totals. Individual
search pages are capped at 4 MiB. Reverse geocoding loads only nearby z14 cells.

## Labels and peaks

`labels/places` may contain `{schema:"places-paged-v1",zoom:8,overview:[...]}`.
The overview holds cities for zooms below 8. Higher zooms fetch visible
`labels/settlements/8/x/y` blocks using the existing `places-v1` payload. Street
and POI labels retain their payloads but now live in spatial directory pages;
renderers discover them from the viewport instead of scanning all label keys.

`query/peaks` may contain `{schema:"peaks-paged-v1",peak,known,unknown}`: the
maximum and counts answer the highest-peak operation without a continent-wide
scan. `query/peaks-data/8/x/y` retains geographic records for selected excerpts.
The legacy peak array remains readable.

## Resource bounds and checkpoints

SQLite caches are 16–64 MiB per connection, with temporary state on disk. Node
coordinates occupy about 17.07 bytes each including alignment; file-backed mappings can still contribute to
resident/cgroup memory. Source tiling batches target 4 MiB or 5,000 features,
with a 32 MiB maximum individual source geometry. Relation assembly has limits
of 32 nesting levels, 100,000 nested relations, 64 MiB compressed relation data
and three million member points. These are working-set guards, not a guarantee
that a complex source can never exceed a process limit while decoding.

Fragment merging checks the normal payload limits before publication. Display
tiles allow 500,000 features and three million points. Extraction cells retain
whole source objects at z12: this duplicates large geometry, and an object may
span at most 4,096 cells. This remains a scaling limit for very large polygons.
Settlement/peak geographic pages and search pages are limited to 4 MiB; routing
cells to 16 MiB. The archive metadata root remains capped at 64 MiB, with a
180,000-directory-page construction guard. Reaching a limit fails the job with
its completed stages intact rather than publishing a partial dataset.

Graph checkpoints use SQLite WAL with FULL synchronization. At PBF blob
boundaries (after roughly five seconds or 128 blobs, whichever comes first),
they commit the source byte cursor, canonical segment counters, restriction
counts and inserted edges together. A single expensive blob/cell can take longer.
Membership and coordinate files are flushed before their matching cursor commit.
Resume truncates uncommitted coordinate appends and rolls back uncommitted SQLite
writes. Encoded cells and their removed edges commit together; completed profiles
are retained and replayed to the final archive after a stop. Scratch is removed
only after the transport archive has a durable stage receipt. The old pre-cursor
`routing-spool.sqlite` cannot be recovered and is discarded on migration.

Graph identity includes the compiler schema, canonical source path, size,
mtime and the input SHA-256 provided by the normal compiler. The CLI's standalone
native verification mode uses path/size/mtime when no hash is supplied.

Stage identity includes the source SHA-256, selection recipe and compiler
version. Completed stages are verified before reuse. Atomic SQLite batch commits
couple display fragments to their source cursor. Publication writes to a partial
file, validates the directory, compacts payload offsets in bounded chunks,
fsyncs and atomically renames. The old output survives a failed replacement.

The host preserves 60 GiB free, with a further 2 GiB stop margin while building.
Its large-build admission allowance is output budget + 64 GiB scratch + 60 GiB
reserve. On resume, existing extraction bytes are credited against the scratch
allowance; reserve and output allowance remain intact. It is deliberately described as a minimum, not a measured Europe
workspace estimate. The first continental run must measure peak disk use and
memory, completion, coverage and long-distance routing before we claim Europe
is supported without these prototype limits.

## Progress and recovery verification

The host shows a measured current-stage percentage, units (bytes, ways or cells),
last checkpoint time and an approximate current-stage ETA after five seconds of
samples. ETA is calculated from work done in this attempt, not the original job
creation time, and is reset on resume/stage transitions. The eight routing stages
are reference scan, coordinate scan, then graph partitioning/cell encoding for
each of walking, cycling and driving. Source features, semantic/search building,
display tiles and final assembly follow; routing percent is not overall percent.
No whole-build ETA is claimed before these stages have measured timings.
Source-store and semantic construction still have stage-level recovery; display
fragments have batch recovery. Checksum verification restarts its scan after a stop.

`bun run verify:graph-resume` kills the real compiler six times across reference,
coordinate, graph and cell stages. It also injects an uncommitted coordinate
append, checks byte-identical final stream/replay and rejects changed source
identity. `bun run verify:partitioned-graph` checks all 242 fixture cells against
the independent regional compiler. The shared coordinate regression records page
accesses inside the actual lookup: the old implementation touched ten pages for
the probe; the new implementation touches one. This is a locality bound, not a
claim of a tenfold whole-build speedup.

### Semantic, display and archive progress

TypeScript compiler passes now emit the same structured `ATLAS_PROGRESS` events
as routing: named locations, source objects, grouped streets, search records and
postings, search/reverse cells, semantic/display packing, display geometry,
building-height statistics, archive directory/payload writing and stage checksums.
Totals come from SQLite counts or actual bytes. Display resume counts rows before
the committed `(cell,rowid)` cursor; row IDs can have gaps and are not totals.
A rolling three-minute throughput window provides an approximate **current-pass**
ETA after 15 seconds of new work. Stage changes and counter regression reset it.
No stage percentage is treated as a whole-build percentage.

For a compiler already running on older code, `scripts/observe-compilation.ts`
can read its job messages, completed-stage receipts and source SQLite counts. It
never edits checkpoints or holds a database connection between samples. It writes
only a small JSON observation file for the host console, every 15 seconds, and
exits when no jobs remain active. Unknown legacy sub-stages stay indeterminate.
The console accepts observations only for the exact running job and discards them
after 45 seconds. This bridge permits a static console update without restarting
an expensive build; subsequent normal deployments use the new compiler events.

```sh
bun scripts/observe-compilation.ts /path/to/data/hosted /path/to/dist/host/compiler-progress.json
```

The bridge is optional and temporary. Native progress remains the fallback when
it is absent or stale. A normal deployment is still blocked while preparations
are active. Updating the console alone does not replace an already-running
compiler or change its recovery guarantees.
