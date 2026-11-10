# Build storage

The host console's **Storage** tab separates permanent map storage from build
workspace storage. It applies to **new builds from PBFs already registered in the
source library**. The final product remains one self-contained `.atlas` file in
the normal hosted library.

## Choosing storage

- **Map disk**: use the existing layout.
- **Use extra space when needed**: assign the extra location when the job's
  planning allowance exceeds current map-disk free space.
- **Always use extra space**: assign the extra location to every new eligible job.

Choose a detected mounted volume or an existing absolute server folder. **Test
this folder** checks writing, syncing, renaming and reading a small file. Atlas
creates its own `atlas-workspaces` child directory and volume marker. Saving
persists the policy in `hosted/work-storage.json`; no environment-variable edit
or service restart is required. A folder on the same disk adds no capacity and
is labelled accordingly.

Atlas uses an already-mounted path, not an `smb://` URL. It does not collect SMB
credentials, mount or format disks. The server account must have access to the
mount. A user-session GVFS mount must be reconnected after logout/reboot before
its jobs can resume; a persistent OS mount is preferable for unattended service.

## What goes where

| Data | Extra local disk | NAS assistance |
| --- | --- | --- |
| Original source PBF | Remains at its registered source path | Remains at its registered source path |
| Extracted PBF and ocean inputs | Extra disk | NAS |
| Native coordinates, SQLite source/graph/search stores and temporary indexes | Extra disk | Local map disk |
| Intermediate `.atlas` archives and assembly payloads | Extra disk | NAS |
| Final verified `.atlas` | Map library | Map library |

SQLite's locking and durability assumptions are not reliable across arbitrary
network filesystems ([SQLite's guidance](https://www.sqlite.org/useovernet.html)).
Consequently network and unknown/FUSE filesystems get the conservative hybrid
layout. Writable archive-directory indexes stay local even when their payloads
are on the NAS. No remote SQLite writer is introduced.

NAS assistance **does not make SSD needs disappear**. Large source and routing
databases still need substantial local space, and finished maps accumulate in
the library. Planning allowances are heuristics, not reservations: NAS currently
uses the full build allowance for external space and up to 64 GiB plus the runtime
floor for the local database allowance. This can underestimate continent-sized
databases. Both volumes are checked during work and existing low-space stopping
rules remain in effect. The normal “start anyway” override bypasses estimates,
not those runtime checks. NAS I/O is also slower than local SSD I/O.

## Checkpoints and publication

Each job persists its exact workspace, artifact paths and volume marker. Changing
the global policy affects future jobs only. Old jobs and queued jobs keep their
original paths, including the two adjacent demo jobs and paused Western Europe.
Moving existing native checkpoints can invalidate their canonical-source-path
identity; this UI deliberately does not perform migration.

A missing mount or changed volume marker stops the job instead of creating a
replacement directory on the system disk. Reconnect the original mount before
resuming. Partial native stages retain their normal transactional checkpoints.

Publication across volumes streams to a private `.part` on the map disk, fsyncs
it, rereads it for SHA-256 verification, then renames it into the final path.
The library announces the map only after normal package verification. The
source archive and stage receipts remain available on failure. Once ready,
the build's owned workspace directories are removed; source PBFs and unrelated
files on the volume are retained. A failed cleanup is logged without discarding
the verified map.

Imports, image uploads, direct Geofabrik preparations, Atlas excerpts and
amendments retain their existing placement in this first slice. To use a cached
Geofabrik PBF with the new layout, select it from the source library for a new
build. Policies are not an automatic mid-build disk migration system.

## Administrative API

These endpoints share the host's existing administrator and same-origin checks:

- `GET /admin/preparations/work-storage`: policy, detected locations and space.
- `POST /admin/preparations/work-storage/test`: `{ "path": "/mnt/nas/atlas", "label": "MyCloud NAS" }`.
- `POST /admin/preparations/work-storage`: `{ "policy": "when-needed", "path": "/mnt/nas/atlas", "label": "MyCloud NAS" }`.

POST requests require same-origin `Origin` and `Content-Type: application/json`.
Switching back to `map-disk` is allowed even if the old extra volume is offline.

## Verification

Regression coverage exercises automatic placement, settings persistence,
missing/replaced mounts, disabling an offline location, guarded cleanup,
split SQLite/payload placement and interrupted publication. A native fixture
compares all routing, search and display block hashes between single-disk and
split builds, then verifies resume reuses the saved archives. Browser checks
exercise folder testing and saved policy on desktop and mobile.

## MyCloud deployment — 1 November 2026

Deployed code revision `49c89d3` as
`20261101T071720543Z-49c89d359bb1-9c05556e`. The LAN host's default policy is
`when-needed`, with the existing MyCloud Public share's
`atlas/atlas-workspaces` folder selected. The actual share was detected as a
network filesystem on a different volume.

Validation passed: 396 Bun tests, TypeScript, desktop/mobile UI checks without
browser errors, and a native build against the real NAS. The NAS probe generated
13 routing/search/display blocks, reused its stage archives on rerun, verified
cross-volume copy/readback, and tested partial-copy cancellation without losing
the source archive. Probe directories were removed afterward.

The separately running Western Europe checkpoint transfer was not interrupted.
It had finished copying and entered checksum verification when this setting was
activated. The two smaller existing jobs retain their original SSD paths and
the previously configured recovery sequence; this setting does not migrate them.
