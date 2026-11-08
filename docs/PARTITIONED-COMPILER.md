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

## Bounded native routing output

The CLI opts into compiler IPC version 1 with `ATLAS_GRAPH_OUTPUT_ACK=1`.
The native process announces a 1 MiB output window, emits complete cell frames,
and requests a one-byte acknowledgment before sending the next batch. The CLI
acknowledges only after all preceding archive writes finish. One larger cell can
occupy a batch by itself, subject to the existing 32 MiB IPC payload guard.
This bounds producer run-ahead even when the runtime eagerly drains child pipes
and the archive is written to slow NAS storage. Standalone native invocations
without the flag keep the original stream. CLI and native binary must be updated
together; an old binary produces a rebuild instruction.

The North Sea recovery on 5 November 2026 reproduced an invalid frame with the
old reader and a real NAS archive writer. Input chunks grew to nearly 2 GB;
a read-only replay of the same checkpoint passed all 483,555 cells. The largest
cell was 925,192 bytes, well below the payload guard. Increasing the cell limit
would therefore hide a transport problem rather than repair an oversized cell.
Changing only the process-stream API still allowed approximately 19 GB resident
memory. Explicit producer acknowledgments avoid depending on runtime pipe
backpressure. Header errors now include the stream position and previous key.

This changes only temporary compiler IPC, not `.atlas`, RCL2/RCL3 cell bytes,
source identity or checkpoint versions. Completed graph cells can be replayed
from the existing SQLite checkpoint without repeating graph construction.
Regression checks exercise delayed writers, fragmented frames, missing credits,
truncation, cancellation and unchanged standalone native output.

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

The host preserves 10 GiB free, with a further 2 GiB stop margin while building.
Source downloads, compiler guards and UI estimates share the reserve policy in
`packages/provisioning/src/capacity.ts`. New large builds require output budget +
64 GiB scratch + the reserve as a minimum admission allowance.

A stopped partitioned build with a saved extraction instead requires the 12 GiB
compiler floor plus up to 64 GiB restart headroom (bounded by the output ceiling).
This permits incremental progress without reserving the full output ceiling
again. The worker still verifies checkpoints, enforces the unchanged archive
size limit and continuously checks actual disk space. It can stop again later;
restart admission does not promise enough space to finish. Missing extractions
and the regional compiler retain their original full admission calculation.

The first continental run must measure peak disk use and memory, completion,
coverage and long-distance routing before we claim Europe is supported without
these prototype limits.

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
exits when no jobs remain active or queued. Pass `--once` to capture one sample. Unknown legacy sub-stages stay indeterminate.
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

### Activity panel and source-object packing

The Activity rail puts running builds first and queued builds in FIFO order.
It renders a capability-aware stage timeline even for legacy text-only workers,
plus measured counters, current-pass elapsed time/ETA, saved stage bytes and the
last reported checkpoint. Unknown totals stay indeterminate; “Observed this
pass” measures only the observer’s lifetime and is not full compiler elapsed time.
A checkpoint timestamp identifies saved work, not a promise that every unfinished
operation resumes from its current counter.

Measured n/x counters remain visible under **Previous pass counts** after a pass
changes. A reported fraction is labeled “Last reported” unless its numerator
reaches the measured total. New counters with no total show `n / ?`; completely
unmeasured passes explicitly say that their item count is not reported. Counters
are not reused as a percentage or ETA for a different pass. Counter regressions
invalidate later observations from a previous attempt.

For a legacy worker already indexing exact tag values, the observer can recover
completed object packing and identity-lookup counts from its read-only records
index: that compiler message is emitted only after both operations finish.
Busy databases remain untouched. Native counters without a stage-name field are
preserved rather than overwritten by the observer's fallback.

Source-object packing and identity lookup now emit structured progress using the
writer’s existing object counts. Tag indexing reports a growing term count until
its total is known; object sorting and tree assembly remain indeterminate.
These events add no full-table counting pass. The legacy observer honors the job’s
workspace path and can read a packing denominator only when SQLite permits a
read-only query. A busy index is left alone and its ETA remains unavailable.

### Multi-core execution

Search-index construction and display batches now support bounded worker
processes. The default is up to six, configurable with `--workers 1..8` or
`ATLAS_COMPILER_WORKERS`. One preserves the sequential reference. Workers write
private scratch files; deterministic merging keeps output and resume cursors
stable. See [parallel compiler details](PARALLEL-COMPILER.md) for resource
limits, recovery behavior, measured results and stages that remain serial.

### Source-store recovery (October 2026)

The source geometry stage now uses a rollback journal with FULL synchronization.
PBF blob boundaries commit the byte cursor, counters and SQL writes together,
roughly every five seconds or 128 blobs. Coordinate appends are synchronized
before that commit and truncated back to the saved count on resume. Multipolygon
assembly saves its last relation ID; duplicate outer-way removal commits batches
of 10,000 IDs. Coordinate scratch is released after area assembly. Index creation
is atomic but restarts that individual operation if interrupted. A structural
SQLite check runs before the completed source stage receives its archive receipt.

Source identity binds the compiler schema, input path, size, mtime and supplied
SHA-256. Old unreceipted source databases have no safe cursor and are rebuilt;
completed transport/semantic/display archives retain their existing receipts.
Source passes report their own progress and approximate ETA. SQLite diagnostics
and the current OSM object ID are retained if a native operation fails.

`bun run verify:source-resume` kills the real importer in five phases and checks
rollback, coordinate truncation, source-table parity, completed replay, and
changed-input rejection. Run `cargo build --release -p atlas-osm-import --bins`
first. `bun run verify:source-store` checks parity with the regional importer.

The Europe run reported SQLITE_CORRUPT after 104.6 million ways on October 13.
A full read-only `quick_check(10)` of its 38.35 GiB source database returned `ok`;
a write probe on an isolated copy also succeeded. Those checks do not establish
the original trigger or prove table/index correspondence. No kernel errors were
found and 119 GiB was available after failure. A separate regression reproduces
corruption when an unjournaled transaction spills updates and fails; journaled
transactions fix that demonstrated recovery defect. This hardening is not proof
that the historical failure's root cause has been identified.

## Dense spatial search cells

A z14 cell can contain more than 4 MiB of valid address or street records. It now
splits into payload pages targeting 256 KiB, with a hard 4 MiB ceiling per page.
A single record larger than 4 MiB still fails explicitly with its ID. Byte
accounting includes the JSON wrapper, commas and UTF-8 encoding. There is no
record dropping or increase to the archive reader's payload limit.

Small cells retain their inline `locations-v1` / `streets-v1` payload. Larger
`search/locations-data/14/x/y` and `search/streets-data/14/x/y` blocks contain
`{schema:"locations-cell-paged-v1"|"streets-cell-paged-v1",pages:[{key,bounds,count}]}`.
The referenced payloads are `search/location-pages/16/x/y` and
`search/street-pages/16/x/y`, using the ordinal address mapping above. Their
contents use the original record schemas. Coordinates in page bounds are WGS84.
All directories and payloads remain inside the same `.atlas` file. Updated
readers support both old inline and paged spatial cells; older consumers must
update before reading newly compiled dense cells.

Workspace preparation, reverse geocoding and Atlas-to-Atlas extraction share the
page reader. It validates references and counts, skips pages with disjoint bounds,
and follows normal reader cache, integrity and transfer-budget handling. Text
search continues using the existing independent name index.

The Central Europe build on 2026-10-27 failed at 35,228 / 40,424 location cells
because the previous compiler treated one cell as one payload. The regression
fixture reproduces that failure with 600 individually valid UTF-8 address records
in one cell; it also verifies dense reverse-street cells, name lookup, workspace
counts and a rebuilt excerpt. A resume retains the completed source database,
extracted PBF and routing archive, then recomputes the failed semantic stage.

Version 4 checkpoints can resume under compiler version 5 only when the complete
old fingerprint matches the current extracted-PBF hash and exact selection. The
migration retains `source.sqlite`, `transport.atlas` and `display.atlas` receipts,
invalidates semantic packing (v5 introduced paged selectable features), backs up
the old receipt as `partitioned.json.v4`, and atomically publishes the new one.
Every retained file still passes its normal size/SHA-256 verification before use.
Other versions, changed input and changed recipes remain rejected.

## Recoverable source-object staging (6 November 2026)

The source-object pass no longer expands all geometry and topology into a second
SQLite database. It emits compressed payload blocks while reading the source,
using at most 128 spatial/class buffers of 64 KiB each. The append-only
`source-objects-stage.payload` follows the selected artifact workspace (NAS for
NAS-assisted builds). `source-objects-stage.sqlite` stays on the local compiler
disk and contains compressed attributes, payload references, block descriptors,
identity/page indexes and checkpoint state. These indexes still grow with the
number of objects and tags; this is bounded payload buffering, not constant
whole-build disk usage.

The native source's `(cell,rowid)` index supplies an exact resume cursor without
a whole-source sort. Source ingestion and attribute packing commit every 10,000
objects; identity indexing commits every 10,240 identities; tag indexing commits
every 10,000 complete terms. Extra ocean objects checkpoint every 1,000 objects.
Payload buffers are flushed and the payload file is synced **before** SQLite
commits its transaction with the cursor, counters, block keys and output length.
SQLite uses DELETE journaling and FULL synchronization. Reopen recovers its
journal and truncates the uncommitted payload tail. The full recipe/source
fingerprint must match. Blocks are checksum-verified when copied to the archive.

Exact-tag postings are inserted once per attribute page, rather than once per
object. An ordered postings scan replaces the old tag/object/page join and
large DISTINCT sort. Spatial grouping keeps unrelated distant geometry out of
the same small payload pack.

A separately verified `source-objects.atlas` stage finishes **before** the
search, labels and selectable-feature spools are allocated. Its staging files
are reclaimed only after the archive has a size/SHA-256 receipt. The final
package merges feature kinds and capabilities and still contains everything in
one `.atlas` file. Existing completed v8 transport, source, display and semantic
artifacts remain reusable; no source snapshot or routing identity changes.

Recovery retains committed ingestion, packing, identity and tag batches. Spatial
sort creation and final tree assembly may repeat if interrupted; archive copying
and prefix finalization can also repeat, reading the completed checkpoint store.
The host reports workspace payload bytes and local index bytes separately,
alongside pass counts, ETA and checkpoint time. Free-space guards remain active.

Validation: the source-object suite covers exact geometry, relationship roles,
Unicode/empty tags, excerpt pruning and shared payloads. Recovery tests interrupt
all four passes and kill a subprocess with a hot journal and uncommitted payload.
The real Liechtenstein PBF integration produces one file with all capabilities,
including searchable explicit addresses and readable source objects. Its 63,373
source objects used 23.06 MiB of local index and 5.78 MiB of compressed workspace
payload at the end of ingestion; this small fixture is not a continent-size
forecast.

## Compact search-name staging (8 November 2026)

Both serial and parallel name indexing accumulate bounded batches of
`term → sorted record IDs`. The temporary SQLite spool stores one row per
term/batch with delta-encoded, optionally gzip-compressed uint32 IDs. A single
ordered primary key replaces the former row-per-gram table and duplicate sorting
index. Parallel shards cover disjoint ordinal ranges; their ordered chunk merge
recreates the same `postings-v1` pages and term catalog. No file format or reader
migration is required. The accumulator flushes after at most 262,144 postings
plus the current record; decoding holds at most one posting chunk at a time.

Temporary databases remain local, including during NAS-assisted builds. This
reduces index amplification; it does not make whole-build disk use constant.
Search/label/feature staging is still disposable and repeats after interruption.
Completed source-object, source-geometry and routing receipts remain reusable.

A repeated-address regression fixture with 20,000 records and 4,226,200 postings
used 157,794,304 bytes before this change and 4,898,816 bytes afterward (including
record pages). Worker time on the development Mac fell from 4.13 s to 0.54 s.
These fixture numbers are not a forecast for a continent. An independent
comparison against the previous compiler produced identical bytes for all 6,299
blocks of a multilingual 8,193-record fixture, with both one and four workers.
