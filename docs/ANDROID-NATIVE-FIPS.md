# Android Atlas over native FIPS

The isolated `apps/android` viewer reuses Atlas's map reader, Hashtree range
resolver, Rust/WASM renderer and touch input. Native Rust owns all peer access
and resource authorization. The migration comes from napplet-space
`d00ec1ea657c279c120de2c25f071298d17ecfdc`; that original demo remains intact.

[Build and provider setup](../apps/android/README.md) ·
[Acceptance evidence](../apps/android/VERIFICATION.md) ·
[Production Soyli handoff](SOYLI-FIPS-HANDOFF.md)

## Every hop

```mermaid
flowchart TB
  UI[Android host: public connection settings and lifecycle]
  W[Bundled WebView: AtlasMap + touch input + WASM]
  R[AtlasReader: map directory and geometry ranges]
  H[HashtreeSource: ranges to tree nodes and leaf hashes]
  B[Narrow Java resource bridge: id, granted root, blob hash]
  P[JNI / Rust: signature, grant, membership and SHA-256 checks]
  N[Native FIPS endpoint: pinned peer]
  T[Physical TCP or UDP socket]
  S[Independent native atlas-peer: logical TCP/FIPS service 39018]
  F[Existing published .atlas files + read-only SQLite Hashtree indexes]
  UI -->|selects carrier, endpoint, publisher and root| P
  W --> R --> H --> B --> P --> N --> T --> S --> F
  F -->|bounded bytes| S
  P -->|verified bytes only| B
  B --> H
```

The reliable logical **TCP/FIPS** stream runs over the selected physical TCP or
UDP carrier. Choosing UDP really uses a UDP socket; it does not make Atlas reads
unreliable datagrams. The native client checks the connected peer's reported
physical transport and refuses an unexpected carrier.

The provider is a separate Rust process on the Atlas server. With `--host-data`,
it reads the host's existing publication records, SQLite Hashtree indexes and
finished `.atlas` files directly. There is no map copy or re-indexing. It uses
separate peer/publisher keys and ports, and does **not** proxy the deployed
TypeScript WebSocket provider. The offline `offers.json`/blob export remains an
alternative fixture mode. There is no hidden WebSocket, HTTP map/catalog read,
DNS dependency, STUN/TURN, system TUN/VPN or USB data forwarding in this tested
path. The existing
production service, builds and files are not changed by the Android module.

The WebView loads `https://atlas.invalid/viewer` solely through an exact local
request interception returning an APK asset. This synthetic URL is not resolved
or fetched. All other WebView requests are denied. JS, CSS and WASM are embedded;
map bytes arrive through JNI, not through a browser fetch.

## Trust and resource contract

1. Native configuration pins the numeric endpoint, carrier, FIPS peer npub,
   publisher key and discovery catalog SHA-256. Only public values are bundled.
2. Native FIPS authenticates the pinned peer. The catalog is downloaded through
   the same native blob protocol and its SHA-256 is verified.
3. Native code validates each kind-30064 event's canonical ID and BIP340 signature,
   publisher, expiry, native peer binding, root/address binding, bounds, zooms and
   Hashtree descriptor. Duplicate IDs/roots are rejected.
4. The Android host grants one offered root. The configured demo automatically
   grants the last selected map, or the first verified map. Page code cannot
   select peers or grant roots.
5. The page may request only `{id, root, hash}` through the bridge. Initially only
   the granted root is readable. A verified MessagePack file node admits its
   children only after native hash, type, size, depth and fanout validation.
   Unknown hashes, ungranted roots, expired offers, corrupt bytes and malformed
   membership proofs fail before data is delivered to the renderer.
6. AtlasReader opens the verified package directory; its snapshot must match the
   signed offer. It is configured for purpose `map` only, with labels disabled.
   Routing/search/extraction are not loaded by startup.

The root grant permits that file's verified descendants. Geometry-only is the
trusted renderer's purpose policy, not a native per-family byte-access ACL. This
standalone app is not a general napplet host and makes no new SDK permission.

**Discovery is an explicit experimental native profile**, `atlas-native-v1`, with
`native-peer` binding and a hash-pinned signed catalog. It reuses Atlas manifests,
Hashtree trees and the blob wire protocol; it is not a finalized NAP extension or
a drop-in replacement for the browser's provider descriptors. The TypeScript
provider/catalog parsers currently require different transport metadata. No
existing parser is weakened to accept arbitrary native endpoints.

There is no relay subscription, client-side live withdrawal processing, revision
arbitration, signed default composition or provider failover in this native demo.
The host-backed provider rechecks publication presence, ready/served status,
snapshot/root identity and the master FIPS switch on each blob read. A withdrawal
therefore denies subsequent reads immediately; it does not erase bytes already
delivered or instantly remove an item from the client's snapshot picker. The
catalog expires in seven days; restarting its provider reuses the catalog while
valid and stable keys keep the peer identity fixed. Expiry or a changed map
library requires a provider restart and new public configuration. Newly finished
maps are not silently added to the pinned catalog. The existing production
browser path remains documented in [FIPS-HOSTING.md](FIPS-HOSTING.md).

## Map and tile selection

The native **Hosted maps** button remains visible after opening a map. Its signed
catalog lists geometry and raster archives; satellite names include the region
from the archive metadata. Selecting a map revokes the previous root grant, closes
its renderer and opens the new verified root. Queued reads for an old root fail
individually, without terminating the replacement session.

**Layers** lists only the selected manifest's display layers. Geometry switches
change both the renderer mask and tile scheduler; imagery switches change the
raster plane's requested keys. The application requests visible tiles at the
current zoom, not an entire archive. Hashtree leaf alignment can include nearby
bytes in a fetched blob, so layer choice is not a per-byte confidentiality claim.
Routing, search, extraction and labels remain off. One archive is selected at a
time; simultaneous Android map composition remains future work.

## Host isolation and lifecycle

Only bundled trusted renderer code runs in the WebView. It cannot navigate to
remote pages, load frames/workers, access arbitrary files, use service-worker
networking, or open sockets. A hash-based CSP with `connect-src 'none'` complements
Android's blocked network loads. Text from map manifests goes through
`textContent`. `evaluateJavascript` transports JSON values; it never interpolates
unescaped code from map fields. The design follows Android's
[local-content interception guidance](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content).

The native queue is bounded to 128 requests; blobs to 2 MiB; proof nodes to depth
16/fanout 128 and one million remembered links. Connect/read deadlines are 25
seconds. These are demo resource protections, not limits on the size of the
Atlas file. Verified content is held in a small in-memory Hashtree cache; renderer
meshes and directories have separate budgets. The optional offline exporter
duplicates bytes. The host-backed adapter instead reads bounded original-file ranges and inline index nodes, verifies every SHA-256
and rejects changed files using the same inode/size/nanosecond fingerprint as the
host. It never opens an index or map for writing.

Cancel, backgrounding and network replacement revoke the active session and
close its endpoint. Returning or restoring connectivity reconnects with the same
pins. An explicit Disconnect suppresses automatic reconnect. A generation token
and monotonic request IDs prevent old renderer requests from taking over a new
map. Page-level abandoned reads are removed from its waiting set; cancellation
of individual already-queued native blob reads is not yet implemented. Session
cancellation closes all outstanding work.

Diagnostics show actual carrier, pinned identity/settings, signature validation
status, verified payload bytes, blob counts, visible tile counts and errors.
Payload counts exclude FIPS encryption and transport overhead. The provider
releases completed application transfer slots while its transport stack handles
FIN/retransmissions, preventing the earlier eight-stream exhaustion failure.

## Scope still to implement

- Native transport metadata in the shared discovery/resource contract, live
  announcements/withdrawals and standard shell/SDK integration.
- Multi-provider composition/failover and hoster default views on Android.
- Persistent offline cache, viewport retention across session reconnects,
  per-request native cancellation and sustained high-load measurements.
- Internet/cellular and NAT/firewall acceptance, controlled packet-loss tests,
  long-lived sessions and Android versions other than the tested Pixel.

The viewer proves a real native TCP/UDP map path and reuses Atlas rendering. It
does not claim those remaining capabilities based on the transport demo alone.
