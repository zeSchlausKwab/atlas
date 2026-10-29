# Western Europe native routing abort — 2026-10-29

Status: checkpoint recovery verified; the underlying allocator failure is **not diagnosed or fixed**. Do not treat a successful retry as proof that it cannot recur.

The Western Europe job `cf5f054c-a0a5-4e5c-8be3-a94611fc0dfd` aborted at 01:15:18 UTC with `free(): double free detected in tcache 2` (SIGABRT). The deployed release was `20261028T130238184Z-f00f2de1e5e8-ded1d8b5`. This was not the disk-space guard: 236 GiB remained when inspected.

The core dump locates the second free in the drop of a PBF `PrimitiveBlock` string table. Entry 343 in the 3,940-entry table should contain `fine_gravel`. This establishes where the allocator detected the error, not where corruption began. No application Rust ownership change has been made speculatively.

## Reproduction and recovery evidence

- Source extract: SHA-256 `b71947865849ed4ae70d973287e19e73631b5a46541bd8389fd2532ae3fd5b67`, 35,804,771,599 bytes.
- Saved routing stage: cycling ingestion, 22,739,855 of 66,051,399 ways. Walking already had 1,953,652 encoded cells; driving had not started.
- Saved input cursor: 27,220,709,166. The failed block ends at 27,223,045,814.
- A 260-block sample surrounding the checkpoint passed 20 parser/tag-decoding repetitions with the deployed parser dependencies.
- The deployed, unchanged routing executable processed the same sample into an isolated SQLite spool: 263,406 cycling ways in 21.5 seconds.
- Valgrind replay of five blocks around the precise failed block: 1.48 million allocations, zero reported memory-access errors. The process was deliberately terminated at the next phase; termination-time leak summaries are not evidence of a live compiler leak.
- A bounded Valgrind resume of the **real** saved database completed 20 durable checkpoints in 47 seconds, advancing to cursor 27,225,996,368. Zero reported memory-access errors. This crosses the original failing block without discarding any saved stages.

These tests did not reproduce the original abort. A history-dependent native heap bug, an optimization issue, or a transient host memory fault remain possibilities. No hardware fault is established by the available evidence.

## Diagnostics change

The Bun wrapper now preserves the termination signal, an unterminated final stderr line, and the last reported checkpoint. Partial output frames also report a native crash rather than hiding it behind a truncation message. The native compiler and checkpoint format are unchanged. No automatic retry is added for allocator errors.

Validation: real child-process failure tests, TypeScript checking, full Bun suite (305 tests), and every Liechtenstein routing cell matching the reference compiler byte-for-byte in all three transport modes.

If this recurs, preserve `coredumpctl info/dump`, the exact native executable, source identity, and the saved checkpoint before rebuilding. Compare the failing input offset and stack with this incident; do not delete the source extraction or graph checkpoints merely to retry.
