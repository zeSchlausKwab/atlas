# Selective source-feature pages

Implemented 27 October 2026. New imports and excerpts store bounded attribute and
geometry pages inside the same `.atlas` file. Existing archives remain readable.
The running LAN build and published rehearsal files retain their original layout
until repacked and republished; the client reader supports both.

## Why this matters for the AI demo

A small urban question previously decoded whole z12 source-feature cells, including
all footprints. Dense Vienna exceeded the workspace's 64 MiB estimate. New cells
contain a small page catalog. Nearby objects are grouped, so a request reads only
intersecting pages. `workspace_prepare` accepts `geometry:false` for attribute-only
work; the default remains `true` for existing callers and drawing workflows.

Spatial answers remain exact: an interior feature needs no shape read, while a
feature touching the query boundary loads geometry for actual intersection tests,
including courtyard holes. The reader checks IDs and geometry hashes. Compatible
source overlaps still deduplicate by identity and reject conflicts.

The same reader path serves normal feature extraction, browser/server workspaces
and excerpt preparation. Excerpts rebuild referenced pages into their output file;
no parent archive or sidecar is required to use them.

## Measured Vienna rehearsal

Bounds `[16.368, 48.198, 16.392, 48.218]`, both overlapping rehearsal maps, cold
readers, local Mac files, default workspace budgets. Measured once on 27 October:

| Layout / request | Records | Compressed archive bytes read | Estimated working bytes | Prepare + queries |
| --- | ---: | ---: | ---: | ---: |
| Legacy cells, either geometry setting | — | — | Exceeds 64 MiB budget | Fails explicitly |
| Paged, attributes | 3,260 | 1,612,651 | 36,448,510 | 164 ms |
| Paged, with footprints | 3,260 | 2,030,359 | 46,566,740 | 234 ms |

Both paged runs select exactly the same IDs as direct legacy full-geometry
extraction. Both find 1,511 buildings with recorded/estimated height at least 20 m.
After closing both readers, subsequent queries and result pages make **zero source
reads**. The memory figure is the existing conservative workspace estimate, not
measured process RSS; timing is one local run, not a network or model benchmark.

These counts are logical archive bytes. Hashtree fetches whole 64 KiB chunks, which
can include neighboring geometry bytes. Wire-level savings are not yet measured
for the new layout. More small blocks also increase directory and compression
overhead: the two rehearsal archives grew roughly 7–8% after repacking. This trades
some storage for smaller targeted operations.

## Repack without rebuilding geographic data

```sh
bun scripts/repage-features.ts data/pair-rehearsal/west.atlas data/pair-rehearsal/west-paged.atlas
bun scripts/repage-features.ts data/pair-rehearsal/east.atlas data/pair-rehearsal/east-paged.atlas
bun scripts/benchmark-features.ts data/pair-rehearsal 16.368,48.198,16.392,48.218
```

The repacker requires a new output path, leaves input unchanged, and rebuilds only
selectable-feature blocks. It copies decoded payloads for tiles, routing, search,
labels, queries and custom blocks; it may recompress them. Source/parent/graph
identities remain, but the package snapshot, directory offsets and Hashtree root
change. Publish a new immutable offer after upgrading server and client readers.

Large in-progress imports should finish with their current compiler. Do not replace
their release underneath the worker. Completed archives can be repacked afterward.
New compiler workspaces use a bumped checkpoint version; old semantic checkpoints
are not silently resumed with a different output layout.

## Current boundaries

- Pages hold up to 128 features; the writer targets 256 KiB and rejects any page
  over 4 MiB decoded. Huge single objects fail explicitly rather than being truncated.
- Feature data still repeats across intersecting z12 cells. This is not a global
  unique-object store or a full columnar database. Root directory size is unchanged
  architecturally and still grows with the number of pages.
- The compiler still collects bounded cell fragments before paging. This work
  improves the read format; it does not remove every compiler memory limit.
- `geometry:false` avoids full shape retention but may fetch boundary geometry.
  An attribute-only workspace cannot later draw all its shapes offline unless
  they were separately cached and prepared. Filtered-result geometry hydration
  is a planned follow-up, not an implemented operation.
- Legacy cells still read their complete payload. Updating only the client does
  not retrofit paging into a published archive.

## Verification

`bun test tests/feature-pages.test.ts` covers dense attribute-only reads, exact
hole intersection, legacy/mixed composition, self-contained nested excerpts,
cache-only behavior, budgets, cancellation and malformed catalogs.

The full suite passed **197 tests**. `bun run typecheck` and browser bundles pass.
`bun run verify:workspace-build` compiled the local Liechtenstein PBF at z0–16
with all capabilities and verified explicit address and workspace queries after
closing the file. The real two-map benchmark above verifies the repacked data.

See [wire layout](FORMAT.md#feature-pages-v2), [workspace contract](AI-WORKSPACES.md)
and the [client chat design](AI-CHAT-DEMO.md).
