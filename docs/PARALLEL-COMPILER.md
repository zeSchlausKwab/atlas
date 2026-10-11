# Parallel compiler: first implementation

This change is prepared locally for the **next deployment/run**. It does not
replace code, change service limits, restart a service, or touch the live Britain
build on the HM90S.

## Execution policy

The partitioned compiler defaults to at most **six persistent worker processes**,
leaving at least two logical CPUs and roughly two GiB outside its automatic worker budget.
The memory heuristic permits at most one worker per remaining GiB of physical
RAM; this is a concurrency heuristic, not a hard memory reservation. Explicit
values from 1 through 8 override that heuristic. `--workers 1` retains the original
sequential path, useful for comparisons and low-memory/disk-pressure runs.

```sh
# CLI: all of the recipe's capabilities, bounded parallel search and tiling.
bun run cli generate --partitioned --selection recipe.json \
  --input region.osm.pbf --output region.atlas --workers 6

# Host builds after the next regular deployment (six is already the default here).
ATLAS_COMPILER_WORKERS=6 bun run start

# Reproducible local checks, requiring no server access.
bun run benchmark:compiler search 100000 1,6
bun run benchmark:compiler fixture data/liechtenstein.osm.pbf 1,6
```

The host service currently allows `CPUQuota=600%`, `MemoryHigh=16G`,
`MemoryMax=20G`, and `KillMode=control-group`. The quota covers the coordinator,
workers and serving process together. Six workers cannot bypass it; choosing
eight does not grant eight cores of CPU time. Service settings are unchanged.
Changing the worker count does not change recipe identity or invalidate already
completed artifacts.

## Search

The previous path updated one SQLite B-tree for every name/context n-gram. Both
JavaScript execution and that single writer serialized the stage. Merely adding
threads to that connection would retain the bottleneck.

The new path scans stable location IDs once to establish disjoint ordinal ranges,
aligned to 256-record pages. Each worker reads a committed source database and
writes a private database: append postings first, then build a covering sorted
index in bulk. Temporary sort files use that build's scratch filesystem, with
32 MiB writer and 8 MiB source SQLite caches per worker and file-backed temporary
storage. No shared SQLite writer is used by workers.

On the same synthetic fixture, two workers took 11.34 s and four took 8.53 s;
six took 7.83 s. Gains are diminishing rather than proportional to core count.

The coordinator streams records in ordinal order, then merges sorted
`(bucket, term, record ordinal)` streams. It retains one term catalog and posting
page at a time. That preserves term collisions, aliases, name/context distinctions,
record IDs and page contents byte-for-byte. At most eight attached shard databases
keep SQLite's attachment limit and merge cache use bounded. The coordinator's
merge, geographic search cells and reverse-geocoding pages are still serial.

Append tables plus their sorted indexes use more temporary disk than the old
single indexed table. The current free-space stop margin still applies; worker
scratch does not constitute an admission-space guarantee for Europe. Active
scratch is deleted only after all workers have exited. Search retains the
existing stage-level recovery: interrupted shards are discarded and the semantic
stage restarts; no partially merged search archive is published.

## Display tiles

The existing 4 MiB / 5,000-feature source batches and tiling rules are preserved.
Workers generate, simplify, encode and compress batch fragments in private SQLite
files. One coordinator imports those compressed fragments and commits the source
cursor in the same transaction, strictly in source order. This keeps deterministic
feature order and the existing batch-resume behavior, regardless of completion
order in the workers. Batches with no selected geometry also advance the cursor.

There are at most N inputs/results in flight for N workers: a slow early batch
cannot accumulate an unbounded queue. Each worker result is disk-backed; it does
not return a continent of geometry through IPC. A parallel batch is limited to
256 MiB of uncompressed fragments or 200,000 fragments. Individual source geometry
still has the existing 32 MiB guard. These bound work sizes, not the exact expanded
JavaScript heap of arbitrary geometry.

## Failure and recovery

The process pool stops on cancellation, worker errors, unexpected worker exits or
consumer errors. It kills outstanding children and **waits for their exit before
scratch removal**. Under the host service, the whole process group is also owned
by systemd. A normal cancellation preserves previously committed tile batches;
uncommitted batch fragments roll back on reopen. Changing worker count on resume
is safe. No background worker reads or modifies another build's workspace.

A hard power loss can leave temporary `.parallel-*` directories inside a build's
workspace; these are not checkpoints. They can be removed while that build is
stopped. Normal cancellations and worker failures remove them automatically.

## Measured results

Local Apple M3 (8 logical CPUs, 24 GiB RAM), Bun 1.3.11. These are prototype
measurements, not estimates of HM90S or full-Europe completion time.

| Workload | One worker | Six workers | Improvement |
| --- | ---: | ---: | ---: |
| Search construction, 100,000 synthetic named locations | 18.78 s | 7.83 s | 2.40× |
| Display generation, real Liechtenstein z0–16 | 0.80 s | 0.50 s | 1.60× |
| Complete Liechtenstein build, all capabilities | 10.78 s | 9.93 s | About 8% less time |

Search gains include **both** bulk index construction and parallelism; they do
not isolate the effect of CPU count alone. Synthetic search runs emitted identical
block hashes. The complete builds emitted identical final archive SHA-256 hashes.
The small whole-map fixture is dominated by stages not changed in this slice.

Tests exercise concurrent processes, bounded queues, result ordering, cancellation,
worker exceptions/crashes and child reaping, search parity across shard/page
boundaries and empty inputs, and interrupted parallel tile builds resumed against
an uninterrupted sequential reference. A complete all-capabilities fixture also
checks the final file hash. Benchmark scripts clean their own temporary data.

## Remaining serial work

| Stage | Next viable approach | Constraint to preserve |
| --- | --- | --- |
| PBF decoding and source geometry | Decode bounded blobs in parallel, assemble into ordered partitions | Complete relations and stable source IDs |
| Routing graph construction | Partition independent spatial/profile work, share read-only coordinate pages | Cross-cell topology, restrictions, deterministic segment ordinals |
| Semantic source-object pass | Private feature/label/search shards followed by deterministic reduction | Street grouping, duplicate resolution, nearby-place context |
| Search merge and tile-fragment packing | Independent term buckets / tile keys, followed by ordered archive writes | Stable page addresses, output budgets and bounded queues |
| Final archive assembly | Overlap bounded reads, compression and hashing | One consistent directory, atomic publication and disk headroom |

The next large run should record wall time per pass, peak RSS and scratch bytes
before raising worker counts. Shared NVMe throughput and the remaining serial
merge will eventually limit gains; 16 hardware threads do not imply a 16× build
speedup.
