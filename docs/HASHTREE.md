# Hashtree delivery and Nostr discovery

Atlas now has a first interoperable Hashtree transport. The finished `.atlas` is
still one self-contained file containing geometry, graph cells, search, addresses,
labels and retained source features. It can still be copied and opened directly.
Publishing does not require rebuilding geographic data.

## Try it locally

1. Run `bun run setup` and `bun run demo` (see the README prerequisites).
2. In `http://127.0.0.1:3100/host`, prepare an excerpt or publish the current map
   under **Discovery & delivery**. Each library card has **Publish with Hashtree**.
3. In the client **Composer**, use the relay URL and publisher key from the host
   console, then **Listen for maps**. Select the discovered map.
4. Its delivery selector switches between **Hashtree · verified blocks** and
   **HTTP · byte ranges**. Read counters distinguish logical Atlas bytes from
   actual Hashtree network bytes. Existing active HTTP readers stay HTTP when an
   offer acquires Hashtree support; select the transport to reopen them.

The host includes a read-only Nostr relay at `/nostr`. No account, public relay,
remote server, or secret key entry is required. Its generated signing key lives in
`ATLAS_DATA_DIR/hashtree/host-key`, mode 0600. Back it up to preserve publisher identity.

## What is implemented

- Standard Hashtree public file nodes, SHA-256 links, nested trees and range reads
  using `@hashtree/core`. Compatibility is tested with the upstream reader.
- 64 KiB leaf chunks and 128-child nodes. The host's rebuildable SQLite index holds
  offsets and tree nodes; leaf bytes are served from the original archive. It does
  not create a second copy of the map.
- Immutable blob delivery at `/hashtree/<root>/<hash>`. Readers verify every blob,
  bound traversal/response sizes, cache by hash and try alternate providers after
  a transport error or hash mismatch. Modified archives require republication.
- Signed kind-30064 events with `d=atlas/<map-id>`, `l=hashtree`, `t=atlas-map`,
  `hash=<root>` and an Atlas map offer in versioned JSON content. The Atlas offer
  profile is our extension; it is not a universal map discovery standard.
- Explicit publisher-key subscriptions, signature/root validation, replaceable
  event ordering and seven-day expiration. Sessions remain pinned to their chosen
  snapshot. Same-root mirrors combine providers; different source revisions are
  not silently merged. Click **Listen for maps** again to reconnect after a drop.
- The HTTP catalog also carries tree offers, so Nostr is optional for delivery.
  Routing, search and task workspaces use the same AtlasReader interface.
- Browser blob cache shares the existing 128 MiB persistent LRU. Purge caches
  clears it too. Complete cached Atlas blocks remain usable without blob requests.

The relay serves this host's announcements only; it rejects third-party writes.
Republishing or restarting the host renews announcements. A continuously running
host currently needs republication before the seven-day expiration. Set
`ATLAS_PUBLIC_URL` when the host's advertised URL differs from the request origin.
`ATLAS_DISCOVERY_RELAYS` optionally publishes to an explicitly configured comma-
separated relay list. Leave it unset for local/LAN demos. HTTP on an insecure LAN
and `ws:` discovery require an HTTP client; HTTPS clients need HTTPS/WSS endpoints.

This slice does **not** implement WebRTC/FIPS peer discovery, peer seeding,
Blossom uploads, encrypted maps, automatic relay reconnection, automatic event
renewal, or discovery of every publisher on the network. Nostr is the discovery
channel; verified HTTP blobs are the data channel. Signing an announcement proves
publisher identity, not the factual correctness or freshness of OSM data.

## Selective-read measurements

`bun run benchmark:hashtree data/pair-rehearsal/west.atlas` on the 95,254,666-byte
Vienna excerpt, 27 October 2026. Each run reads the directory and the same 30 small
building/label blocks (336,764 logical bytes). Local HTTP; not a WAN latency test.

| Chunk | Startup bytes | Cold network bytes | Requests | Host index bytes |
|---|---:|---:|---:|---:|
| 32 KiB | 72,395 | 689,399 | 27 | 643,072 |
| **64 KiB** | **72,132** | **944,344** | **20** | **331,776** |
| 256 KiB | 268,317 | 2,632,698 | 13 | 102,400 |
| 2 MiB | 2,099,323 | 33,556,603 | 17 | 24,576 |

Warm replay transferred zero bytes in all cases. The 4 MiB transport memory cache
can evict large chunks during scattered reads. We retain 64 KiB as the prototype
compromise; 32 KiB saved more bandwidth here. Hashtree does not automatically beat
HTTP ranges in bytes or latency. Map selection still happens at the Atlas block
level, with the chunk boundaries creating measurable overfetch.

## Two-map rehearsal

`bun run demo:pair --source data/vienna-plus.osm.pbf` creates a shared compiled
source and two complete z0–16 excerpts. Requires `osmium-tool`, native compiler
binaries and built routing WASM. The supplied PBF must cover the rehearsal box.
The command resumes completed artifacts in `data/pair-rehearsal` and rejects a
changed recipe. The fixture is real OSM, not generated roads.

Verified results: west 95,254,666 bytes; east 61,358,907 bytes; 75 matching overlap
routing cells across the three profiles. Walking, cycling and driving from
Kaiserstraße to Handelskai use both files. `Handelskai 300` returns the explicit
OSM address; reverse geocoding finds Handelskai. A cross-map location workspace
retains 514 records including 30 explicit addresses, reading 619,310 logical bytes,
and queries after both HTTP providers close with zero further reads.

The rehearsal exposed and fixed excerpt search flattening: extracts now rebuild
bounded name and spatial search pages instead of writing a single huge location
block. Dense building geometry still uses coarse feature cells and may exceed the
64 MiB task workspace estimate; the request fails explicitly. Finer feature pages
are a follow-up. No address interpolation, administrative hierarchy completion,
or full postal-address guarantee is claimed.

`bun run demo:pair --large --source /mounted/planet.osm.pbf --dry-run` writes the
proposed Central Europe recipe without starting the expensive build. Both outputs
are extracted from one compiled parent, so graph identity is shared. Real output
size depends on the source; the recipe is a ceiling, not a promised size.

## A verified PBF on a NAS

Mount the SMB share on the server first. Under the source library's mounted-source
controls, select an already verified cached source and enter its mounted file path.
Atlas streams a complete SHA-256 check before registering that path. It does not
accept SMB passwords or mount shares itself. Permitted roots default to the source
cache, `/mnt`, `/media`, and the service user's GVFS mount; configure
`ATLAS_SOURCE_ROOTS` for other mount directories.

CLI equivalent:

```sh
bun run source:register /path/to/data/sources SOURCE_ID /mnt/maps/planet.osm.pbf
```

Registration retains the original SSD file. After successful verification and a
read check, an administrator can remove that redundant PBF while retaining its
receipt and location metadata. An absent or changed external file becomes
unavailable; it never silently substitutes a different source. The browser form's
verification runs in the server process; interruption requires restarting that
verification. Use a service manager for a long CLI verification. A durable OS
mount is preferable to a desktop GVFS session on an unattended host.

Tests: `bun test tests/hashtree.test.ts tests/source-location.test.ts
 tests/provisioning.test.ts` (one shell line). Run `bun run typecheck` and
`bun run build:web` for both browser apps.
