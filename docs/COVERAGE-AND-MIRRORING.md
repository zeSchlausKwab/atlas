# Coverage planning and host consumption

Atlas hosts can consume other hosts' signed announcements and Hashtree archives, using the same reader, manifest verification, routing identity and polygon planner as the browser. The finished map remains one self-contained `.atlas` file. Planning and mirror checkpoints are host state, not additional files a map consumer must carry.

## Host workflow

Open **Coverage & peers** in `/host#federation`:

1. Refresh the local library. Add a publishing Atlas host by its HTTP origin to compare remote sources. The host's Nostr public key is pinned on first addition; subsequent key changes are rejected until the operator removes and adds that host again.
2. Draw a rectangle or polygon, or explicitly use the visible area. Select a data capability and display zoom. Uncheck sources to exclude them. Routing can use an explicit reference map.
3. **Check selected coverage** partitions the area into local, remote verified, unknown, incompatible and missing regions. Both the area totals and the source evidence can be exported as JSON.
4. For a smaller area, **Inspect routing cells** reads directory hashes without loading graph payloads. It draws present, empty, missing, unknown, incompatible and conflicting cells. The exported report includes the inspection.
5. **Mirror whole .atlas** downloads a pinned Hashtree root into the existing durable upload/import pipeline. Pause and resume survive server restart. Completed downloads enter the normal import queue, where archive contents are verified before publication in the library. The original bytes are preserved.
6. **Prepare this area** copies the selected area and capability into the existing preparation form. It prefers a cached planet PBF, otherwise Geofabrik. Review the source, options and snapshot compatibility before starting. This does not start a build automatically or promise that a newly selected snapshot will stitch with an existing routing graph.
7. **Complete this area** reviews multiple capabilities, fetches their selected blocks through Hashtree, and exports a portable `.atlas`. Acquisition checkpoints survive restart; missing coverage requires explicit acceptance. See [area acquisition](AREA-ACQUISITION.md).
8. Use the library's composition/export controls to combine local archives into one self-contained Atlas. This reuses the existing assembly implementation; remote composition does not require flattening or rewriting the source files.

The browser's **Composer → Capability coverage → Check current view** uses the same polygon planner against the selected, opened archives. The viewport is used only when that button is explicitly pressed.

## What each result proves

| State | Meaning |
| --- | --- |
| Local | Matching capability scope in an opened local archive |
| Remote verified | Signed offer agrees with an archive opened through its hash-verified tree |
| Unknown | Advertised or previously known scope could not be verified now |
| Incompatible | Verified routing data belongs to a different graph identity than the reference |
| Missing | No matching source among those selected and checked here |

These are archive coverage claims, not promises of real-world completeness or network connectivity. A header check does not fetch every payload. Missing here does not mean no publisher anywhere has the data. An unavailable peer without any previously known extent is reported as a peer error; the planner cannot invent its coverage polygon.

The planner intersects the request with capability bounds and selection polygons. Display families respect their advertised zoom range. Feature extraction can be selected by retained type, and address search is advertised only when explicit OSM address data is retained. Portable compositions are expanded into their real members; the enclosing rectangle never fills gaps between members.

Routing uses the existing independent OSM contract: authority namespace, exact upstream PBF revision, compiler contract and OSM segment identity. Ordinary scope planning excludes partial edge cells and does not credit selection padding. Detailed inspection uses ownership rules and permitted routing padding. A complete owned cell with no directory entry is empty, not missing. Differing hashes—including present versus empty—in overlapping compatible cells are a conflict. An unreadable directory remains unknown. Neither check executes a route or proves all graph payloads are reachable.

## Implementation and API

- `packages/coverage/src/index.ts`: pure polygon planner shared by host and browser.
- `packages/coverage/src/routing-inspection.ts`: directory-level routing check, reusable with any AtlasReader.
- `apps/server/federation.ts`: trusted peers, signed offer verification, local/remote readers and resumable mirrors.
- `apps/host/src/host-federation.ts`: drawing, reports, mirror progress and preparation handoff.

All administrative mutations require the existing administration policy and same-origin requests. No publisher credentials are used to consume another host. Discovery reads signed Nostr events from the existing `/discovery` endpoint; this first slice uses operator-selected hosts rather than a global relay search. Archive bytes come exclusively through Hashtree, with no raw-HTTP fallback.

`GET /admin/federation` returns peers, inspected sources, families, status and mirror progress. POST actions:

- `/peer` and `/remove-peer`: `{ "url": "http://host:3100" }`
- `/refresh`: `{}`; metadata verification continues in the background.
- `/plan` and `/inspect`: `{ "polygon": [[lon,lat],...], "family": "routing:walking", "zoom": 14, "sourceIds": [...], "reference": "optional-source-id" }`
- `/mirror`: `{ "id": "verified-remote-source-id" }`; storage warnings use the existing explicit override flow.
- `/pause`, `/resume`, `/delete-mirror`: `{ "id": "mirror-upload-id" }`.

The planner returns versioned JSON with source evidence, GeoJSON regions and area totals. The mirror-size estimate is the sum of unique **whole archives**, not a promised minimum download for the selected area. This slice supports one mirror transfer at a time, followed by the existing preparation queue. Regional coverage checks read metadata; detailed routing inspection is limited to 4,096 z14 cells per request so it cannot accidentally scan an entire continent's directory.

Next refinements: resumable bulk cell audits, global relay discovery, minimum-transfer provider selection, and a reviewed plan that prepares only missing sub-polygons. Arbitrary raster/custom families can be inspected and mirrored, but the OSM preparation form cannot generate them.

## Deployment while builds are running

`bun run deploy --stage-only` uploads an isolated release containing source and portable WASM. It performs no Linux compilation, service restart or data migration on the remote host. Its result includes a `--resume RELEASE_ID` command for later activation. Normal deployment still refuses to interrupt active preparations. Staged does not mean live: dependency installation, native builds, smoke checks and activation remain pending until resumed without `--stage-only`.

## Verification

Coverage tests exercise polygon clipping, overlapping sources, capability/zoom exclusions, routing revision mismatch, partial edge cells, empty and conflicting cells, unavailable directories, and root-deduplicated estimates. Host tests use real signed publications and Hashtree delivery with raw map delivery disabled. A mirror is paused after a durable 4 MiB write, reopened, resumed, imported and compared byte for byte. Composition tests reject coverage in the gap between embedded members.
