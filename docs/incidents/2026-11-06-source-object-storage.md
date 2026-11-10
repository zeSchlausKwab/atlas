# North Sea source-object storage recovery · 6 November 2026

Job: `a4a4a7c9-4b2c-4256-a97d-c935f0fb8c16`.
Area and capabilities remain unchanged: North Sea, Britain, Benelux and northern
Germany, z0–16, all selected routing/search/analysis capabilities and ocean data.

## Evidence

The worker stopped at the free-space guard during `semantic-object-packing`:
15,000,000 / 127,698,514 objects (11.75% of that pass). Its temporary object
index stored uncompressed geometry and topology again, alongside compressed
source geometry, search/groups and feature spools. The tag lookup also required
a global distinct join/sort. Disposable spool cleanup after failure returned
SSD free space to approximately 215 GiB. There was no final North Sea file.

Completed receipts remain valid:

- `transport.atlas`: 6,389,101,508 bytes, SHA-256
  `0c99bcbe9d83fe84d10d14dabdea835229b2c6347dee6e64549cd1c174610bd0`.
- `source-v4.sqlite`: 95,353,835,520 bytes, SHA-256
  `1906d1db48e1fbc75ac62aa968640f4f87e74308cfc21335fb4f8d8c780ac93e`.
- Extracted PBF: 7,419,485,444 bytes, SHA-256
  `14db6d5d3fd5586bc56ef3e031346cc91dcab10d9099bce61d1ec1a067055402`.

## Change and validation

Commit `1518eab` streams compressed, spatially grouped payloads to the chosen
workspace and retains compressed attributes plus transactional indexes locally.
The source-object pass has its own verified archive receipt before search/label
spools begin. Ingestion, packing, identity and tag passes retain batch checkpoints.
Output remains one self-contained `.atlas`; source identity and routing IDs are
unchanged. The 10 GiB reserve was not lowered. Existing finished maps were kept.

- TypeScript check and 425 Bun tests passed on macOS.
- 33 focused tests passed on server Linux / Bun 1.3.13.
- Recovery tests cover all four passes plus SIGKILL with a hot SQLite journal.
- Corrupt/truncated payloads and mismatched checkpoint identities are rejected.
- Full Liechtenstein PBF integration built 40,834,862 bytes with all capabilities,
  explicit address search, object geometry/topology and cached workspace queries.
- A disposable test on the actual MyCloud NAS verified payload sync, checkpoint,
  reopen, checksum-checked reads and cleanup.

Deployed release:
`20261106T075447366Z-1518eab27c72-59fa6f98`.
UI, WASM, catalog, range-serving and preparation smoke checks passed. North Sea
was resumed through the normal admin API, which first revalidates saved files.

The new indexes still scale with data volume. The change removes the known raw
payload duplication and overlapping spools; it does not promise that every
future dataset fits this SSD. Source sort creation, final tree construction and
archive finalization may repeat after interruption. No archive format migration
or client re-download is needed for existing maps.

## Live recovery observation

At 08:10:57 UTC the resumed job was running `semantic-object-ingest` with a
transactionally saved cursor at **730,000 / 129,650,971 source objects** (0.56%
of this pass). This ingestion total includes objects subsequently excluded by
the selection; the previous failure's 127,698,514 total was the retained packing
count. The checkpoint held 16,329 compressed blocks, 116,702,395 payload bytes on
the NAS, and the UI reported 254,771,200 local index bytes. SSD free space was
214.94 GiB. Multiple checkpoints had advanced after both existing stage receipts
were reused. This is a successful restart, not evidence that the full build has
finished or that later stages cannot encounter another capacity limit.
