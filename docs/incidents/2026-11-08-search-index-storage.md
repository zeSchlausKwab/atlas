# North Sea search-index storage recovery · 8 November 2026

Job: `a4a4a7c9-4b2c-4256-a97d-c935f0fb8c16`.

## Diagnosis

The 7 November stop occurred during `search-records`, at
36,436,480 / 39,157,949 records (93.05% of that pass), with four index workers.
The source-object fix from 6 November had completed successfully. The temporary
search shards still held one SQLite row per searchable gram, then built a
second full sorting index. Repeated address names and settlement context
multiplied the row count. Disposable stage cleanup returned free SSD space to
about 212 GiB, explaining why the disk looked healthy after failure. The NAS
had approximately 845 GiB free at diagnosis.

A focused worker reproduction, `bun test tests/search-scratch.test.ts`, failed
its scratch-size assertion: 20,000 address records produced 4,226,200 posting
rows and a 157,794,304-byte database, against a 10,000,000-byte fixture threshold.
No finished library map, input PBF or completed checkpoint was deleted.

## Recovery

Compact posting batches remove the per-gram row/index duplication while retaining
all search memberships and the published wire representation. Regression tests
cover scratch size, multiworker/serial equivalence, long postings, aliases,
Unicode, malformed compressed chunks, cancellation and batch boundaries.
See [the compiler notes](../PARTITIONED-COMPILER.md#compact-search-name-staging-8-november-2026).

The unfinished semantic stage must repeat; completed receipts are retained and
verified by the normal resume path:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `transport.atlas` | 6,389,101,508 | `0c99bcbe9d83fe84d10d14dabdea835229b2c6347dee6e64549cd1c174610bd0` |
| `source-v4.sqlite` | 95,353,835,520 | `1906d1db48e1fbc75ac62aa968640f4f87e74308cfc21335fb4f8d8c780ac93e` |
| `source-objects.atlas` | 22,426,289,167 | `9d7d99d998f54542c8b26be1a3ee00180b6ca0afc32467940797118877908c1f` |

The 10 GiB runtime reserve and stopping buffer remain unchanged. A successful
restart does not establish that the remaining display and assembly stages fit;
those stages retain their disk checks.

## Validation and deployment

- TypeScript checking and 53 Rust tests passed.
- All 428 Bun tests passed: 422 in the isolated Linux full-suite run, followed
  by the six client/server tests after replacing validation-only dependency and
  WASM symlinks with a clean locked install and local WASM copies. Bun's bundler
  reported `EISDIR` for files outside that temporary checkout. The Mac full run
  was unsuitable for storage tests: only about 8.7 GiB was free, below the normal
  reserve. Production storage checks were not relaxed to make tests pass.
- Independent old/new comparison: identical bytes for 6,299 published blocks
  from 8,193 multilingual records, for both serial and four-worker compilation.
- Fix commit: `cac6eda`. Deployed release:
  `20261108T164723022Z-cac6eda59ca6-85bc82b0`.
- Candidate UI, catalog, WASM, byte-range, API and preparation smoke checks
  passed. The existing North Sea job was resumed through its normal API, with
  no storage-risk override. It entered checksum verification on the new release.

The reduction measured on the repeated-address fixture is about 97% (158 MB
to 4.9 MB); this is not a promised reduction for all North Sea intermediate data.
