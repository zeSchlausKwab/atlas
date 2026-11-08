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
