# Complete this area

A host can act as a consumer: acquire selected capabilities for a polygon from other publishers, then export one self-contained Atlas file. There is no requirement for a shared compiled mother file. Independent routing sources must satisfy the OSM authority contract described in [routing](ROUTING.md).

## Workflow

In **Host console → Network → Coverage & peers**:

1. Add trusted publishing hosts, let their signed offers and archive metadata verify, and select the sources to use.
2. Draw an area, or explicitly choose **Use visible area**. The camera does not otherwise define the acquisition.
3. Under **Complete this area**, choose the file name, capabilities, display zoom range and routing padding.
4. **Review area acquisition** builds a saved dependency plan. Inspect coverage by capability and display zoom, exact selected stored-block sizes and the local/remote split. Planning may itself fetch catalogs and legacy inline record cells. Hashtree chunk and directory overhead is additional to the block estimate.
5. **Acquire selected data** fetches verified blocks and rebuilds indexes for the excerpt. Gaps require explicit acceptance. Conflicting complete routing cells block acquisition rather than silently choosing an authority.
6. **Pause & keep blocks** preserves content-addressed cached blocks and finished source members. Resume after a network failure or server restart. An unfinished member is rebuilt from cached inputs; this is not a checkpoint for every row of its index builder.
7. **Download .atlas** produces a portable file. **Add to map library** sends that file through the normal verification/import queue; publish it with Hashtree there. Deleting the acquisition and its cache does not remove an imported library copy.

This flow runs on the **host** and produces a portable file. The client also has browser-side acquisition, described below; it pins source blocks rather than exporting a new file.

## Browser saved areas

Open **Client → Offline → Save an area here**. Choose **Use current view** explicitly or draw a polygon, select capabilities and zooms, then **Review saved area**. The polygon stays fixed when the camera moves. Review reports coverage separately for each capability and display zoom, conflicts and selected source-block bytes. Browser storage is keyed by source snapshot, block key and hash; its size estimate includes duplicate payloads under different keys, unlike the exporter's content deduplication.

**Save on this device** runs the shared planner and a worker, reading verified bytes through the selected sources' existing Hashtree transport. Progress remains visible in the card. **Pause & keep blocks** cancels pending range reads; resume reuses hash-verified blocks. Closing the tab stops work, and opening the same source revisions lets you resume. Full plans are stored separately from lightweight progress checkpoints so a large block list is not rewritten on each update.

Saved blocks live in `atlas-saved-areas-v1`, outside the rolling 128 MiB cache. Rendering, routing and AI workspace readers consult this store automatically. Overlapping areas share immutable blocks; removing an area only deletes blocks that no remaining area owns. **New chat** keeps saved areas; **Purge caches** removes them. A save requests persistent browser storage when initiated in the UI, but the browser or user can still evict/clear it. Quota failures are reported and preserve previous committed blocks.

The four AI tools are `acquisition_catalog`, `acquisition_plan`, `acquisition_save` and `acquisition_status`. They use the same controller as the UI and emit progress and package-byte telemetry. A plan requires explicit polygon coordinates; it never silently defaults to the viewport. The harness asks before accepting gaps or overriding a storage estimate. Routing identity conflicts cannot be overridden.

Try: “Prepare a walking trip around these named places. Resolve their locations, show me the proposed area and what data is available, then save walking routing, water geometry and building features on this device.”

This is **a persistent source-block cache**, not a new `.atlas` revision or a guarantee that the entire app will boot with every remote catalog offline. Original map revisions must remain selected to resume. Source cells may extend beyond the polygon; full-text search postings are not rebuilt; relations outside the selection and routes leaving it can require more bytes. Use the host export flow when you need one independently portable archive. No real-world completeness is implied by “ready”.

## Host workbench

The console is organized into **Library**, **Prepare**, **Import**, **Network** and **Tools**. Existing deep links still select the corresponding tab. Source downloads are under Prepare; file/image imports under Import; discovery/publication under Network. Tab changes preserve form state and do not cancel work.

An **Activity** rail remains visible across desktop tabs with build controls, download/upload/acquisition progress, publication and errors. On narrower screens it becomes a fixed expandable bottom drawer. Tab navigation supports arrows, Home and End; reduced-motion preferences are respected.

## Data and correctness

- Local providers are preferred. A wholly redundant provider is omitted; partially overlapping providers retain their native cells and objects. This is not a minimum-bandwidth set-cover optimizer.
- Source revisions and Hashtree roots are pinned at review. A changed snapshot cannot silently replace the reviewed data.
- Display layers, imagery, labels, search/explicit addresses, reverse geocoding, peaks, selectable features, administrative boundaries and tagged objects use the existing excerpt builders.
- Search dependencies include selected spatial catalogs and record leaves, not the source's global term postings. Search indexes are rebuilt on disk. Settlement labels remain paged, avoiding the interactive viewport's 256-page limit.
- Routing uses all selected modes and padding. Complete owned empty cells remain valid coverage. Overlapping compatible cells must agree, including present-versus-empty. Different authority revisions are reported as incompatible.
- During final packing, all source readers and their Hashtree transports are cache-only. A missing dependency fails the job; packing cannot silently expand its network plan.
- A single-source result is an ordinary Atlas excerpt. Multiple contributors are embedded as self-contained members in one Atlas composition. Native routing IDs and separate search indexes are preserved; there are no external source-file dependencies.
- The coverage review is retained with the host acquisition job. The exported map preserves each contributor's actual selection and capabilities; it does not fill missing areas with a fabricated coverage rectangle. Coverage describes retained source scope, not real-world completeness or a guarantee of connectivity outside the selection.

## Persistence and limits

`<host-data>/federation/areas/<id>.json` stores small job checkpoints. `<id>/plan.json` stores the immutable dependency plan once, rather than rewriting every descriptor for each progress update. `<id>/cache` stores hash-verified Hashtree blobs and compressed Atlas blocks. Completed members and `complete.atlas` live alongside it. Cache files are atomically written and verified again when read; damaged entries are fetched again.

One area acquisition runs at a time. Administrative commands are serialized so simultaneous start requests cannot create multiple workers. Source downloads/builds keep their existing independent queue. Acquisitions may therefore compete with a compiler for I/O and disk space: a storage estimate warns first, supports the existing explicit override, and a runtime guard preserves 10 GiB free. The estimate uses six times selected stored bytes plus 64 MiB and the reserve; it is an allowance, not a reservation or an output-size prediction. Cache, temporary index files and packed members can coexist until the acquisition is deleted.

Current limits:

- At most 64 embedded source members; the planner rejects a larger result before payload acquisition.
- Intersections with polygon holes require separate simple selections.
- Custom capability families need an extraction adapter; they can still be mirrored as whole files with the existing mirror workflow.
- Legacy inline search cells require reading the whole cell during planning. Hash deduplication reduces repeated payload storage, but transport chunks can include neighboring bytes.
- Native overlap remains in the output; byte-level deduplication across embedded members is not yet a format feature.
- No whole-job ETA is claimed. The UI exposes stages, current block, completed counts and cached-byte reuse.
- Large continental acquisition throughput has not yet been benchmarked. The regression rehearsal uses small independently compiled publishers.

## API

All endpoints use the existing host administration policy and same-origin checks for mutations. `GET /admin/federation` includes acquisition summaries; private source paths and full block lists are omitted.

- `POST /admin/federation/area-plan`: `{name, polygon, sourceIds, families, minZoom, maxZoom, paddingCells, reference?}`. Returns `{id}` while planning continues. Families use coverage IDs such as `tile:water`, `routing:walking`, `addresses`, `features:buildings`, `boundaries`, `objects` and `raster:<id>`.
- `POST /admin/federation/area-resume`: `{id, acceptPartial?, allowStorageRisk?}`. Starts a reviewed plan or resumes a stopped acquisition.
- `POST /admin/federation/area-pause`: `{id}`.
- `GET /admin/federation/area-file/<id>`: completed `.atlas` download.
- `POST /admin/federation/area-publish`: `{id, allowStorageRisk?}`. Idempotently submits the finished file to the import queue.
- `POST /admin/federation/area-delete`: `{id}`. Requires the job to be idle; removes its checkpoints, cache and export.

## Verification

`tests/acquisition.test.ts` checks selected search leaf dependencies, exclusion of unrelated families, address search/labels/peaks after the publisher goes offline, local-provider preference, gap reporting, cache corruption recovery, and export of 289 settlement pages.

`tests/routing-federation.test.ts` publishes two independently compiled archives through real Hashtree servers with raw map delivery disabled. Acquisition fails during a simulated outage, reopens from its saved plan, resumes, and produces one portable file. With both publishers unavailable, fresh file readers route walking/cycling/driving across the seam at the same cost as the whole-source baseline and find an address. A conflicting overlap is detected during planning.

`tests/federation-host.test.ts` checks same-origin administration, explicit partial-coverage acknowledgement, restart, file download, idempotent library import and deletion of the acquisition cache without losing the imported file. A localhost browser rehearsal exercises the review, acquire, download and import controls.


Browser verification (2026-10-30): a visible localhost rehearsal used real Hashtree delivery and IndexedDB with a one-byte ordinary LRU. It covered plan/save, cancellation during a stalled range read, resume, overlapping ownership/deletion, reload, and source-offline feature reads with no additional provider requests. The AI tool schemas and shared status controller were exercised without model calls. Desktop/mobile checks covered host tab state, deep links, keyboard navigation and horizontal overflow. Continental browser acquisitions remain unbenchmarked.
