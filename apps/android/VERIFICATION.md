# Atlas Android acceptance — 2026-11-11

Branch: `codex/android-atlas-native-fips`. Migrated without shell history from
napplet-space `d00ec1ea657c279c120de2c25f071298d17ecfdc`.
[Original transport-demo evidence](TRANSPORT-VERIFICATION.md) is retained.

## Current deliverable: npub mesh viewer

- APK: `output/atlas-native-viewer.apk`, ARM64 debug, **0.4.0-npub-mesh**, code 3,
  **15,970,447 bytes**, SHA-256
  `f08f3cf7eb05a49ed745656c5b6f7ce944f83087f4c7112994f32aa5a1d82297`.
- Installed on the connected Pixel 10 Pro XL (Android 17). The original transport
  demo remains installed and its source is retained.
- The APK contains public profiles only. A clean launch requires no pasted IP,
  catalog hash, publisher key or manual Connect/Open sequence.
- One map-host npub serves both carriers through a distinct entry peer. The host
  listens on server loopback; its address is absent from the client profile.

### Verified in this update

| Check | Observed result |
| --- | --- |
| Native unit tests | 12 pass; mesh settings derive catalog trust from the host npub and reject mixed trust, DNS endpoints, unknown fields and unexpected carriers |
| Three-node fixture | Both TCP and UDP entry links reach a separate provider over its TCP link; the observed next hop is the entry identity, not the target identity |
| Resource checks | Signed catalog, root grant, descendants, real Atlas header, repeated reads and corrupt-content rejection pass on both mesh carriers |
| Wrong identity / unavailable host | Fail with a bounded error; no target substitution or transport fallback |
| Original direct fixtures | TCP/UDP regression, restart pins and corrupted-content rejection still pass |
| Server native probes | Six real published maps discovered, `ATLAS001` header and repeated reads verified over TCP and UDP; 131,095 payload bytes / 36 hashed blobs including the separately signature-verified catalog bytes |
| Phone automatic startup | Clean app launch loaded Lower Rhine East via bundled TCP entry settings, 12/12 tiles, 57,608 triangles |
| Phone map selection | TCP: Lower Rhine West, 18/18 tiles, 40,925 triangles; UDP: West and Netherlands satellite, 4/4 raster tiles |
| Layer controls | Both carriers: disable layers, zoom, observe 0/0 tiles and no additional package reads; re-enable and load tiles |
| Lifecycle | Both carriers: background/foreground, explicit cancel/reconnect, Wi-Fi loss/restoration all reload the map |
| Real touch gestures | UDP imagery: zoom 6.87→8.47, changed center, 6/6 tiles. TCP vectors: 7.25→8.84, changed center, 10/10 tiles, 74,441 triangles |
| Build validation | Root TypeScript check passes; Android app/instrumentation build; lint 0 errors / 39 warnings; APK signature v2 and 16 KiB alignment verified |

The first phone attempt failed because Wi-Fi was disconnected and the device
routed the private LAN address over cellular. It is not counted as a pass. After
the user reconnected Wi-Fi, the tests above passed. This remains a LAN entry;
Internet/cellular reachability is **not** verified. USB carried test input/logs,
not map data. Phone screenshots were visually inspected.

Server processes are `atlas-native-gateway.service` and
`atlas-native-provider.service`, with separate identities. First physical hop:
phone→entry via selected TCP/UDP. Second: entry→provider via TCP over loopback.
There is no HTTP/WebSocket map proxy. The main Atlas template release was also
activated with the user's authorization, after preserving North Sea checkpoints;
world preparations run independently of these native services.

Evidence remains ignored under `output/phone/mesh-tcp`, `mesh-udp`,
`mesh-final`, `mesh-gestures-tcp`, `mesh-gestures-udp`; public profiles are
`output/mesh-tcp.json` and `mesh-udp.json`. The firewall's persistent Nix module
is still prepared but unapplied; current administrator-installed LAN rules are
runtime rules. Setup and exact limitations are in [README.md](README.md) and
[architecture](../../docs/ANDROID-NATIVE-FIPS.md).

## Previous direct-host deliverable (historical)

- APK: `output/atlas-native-viewer.apk`, ARM64 debug, version `0.3.0-hosted-maps`
  (version code 2), **15,940,387 bytes**.
- Application ID: `org.atlas.nativeviewer`; original `soy.napplet.fipsdemo` retained.
- Physical device: Pixel 10 Pro XL, Android 17. USB was used for installation,
  test input and logs. **Map bytes used LAN Wi-Fi, without adb forwarding.**
- Bundled default: actual Atlas server `192.168.0.179:42131`, physical TCP.
  Alternative preset: `192.168.0.179:42132`, physical UDP. Both have separate
  authenticated peer/publisher pins and signed catalog hashes.
- A clean app launch connects automatically. Saved custom settings take
  precedence over the bundled default.

APK SHA-256:

```text
40a21381aba6dd499222f97ef695c44d7e138b45e624f9fe211241da6000349c
```

## Running-server acceptance

Two isolated Rust `atlas-peer` services on the Atlas server read the existing
published files and Hashtree indexes directly and read-only. No map copy,
TypeScript proxy, HTTP range request or WebSocket hop participates. The Android
host owns native networking; the restricted WebView only renders verified bytes.

The signed catalog contains these six maps. Initial views were loaded on the
physical phone; satellite rendering is measured by raster tiles, not triangles.

| Published archive | Bytes in archive | Observed initial view |
| --- | ---: | --- |
| Lower Rhine East | 19,112,765,373 | 18/18 tiles; 67,466 triangles; TCP and UDP |
| Lower Rhine West | 16,631,274,453 | 18/18 tiles; 40,925 triangles; TCP and UDP |
| Satellite · Netherlands | 149,584,071 | 4/4 raster tiles; TCP and UDP |
| Satellite · Alps | 579,904,977 | 2/2 raster tiles; TCP |
| Satellite · Iran | 2,415,395,452 | 2/2 raster tiles; TCP |
| Satellite · GCC States | 2,264,115,874 | 4/4 raster tiles; TCP |

| Check | Observed result |
| --- | --- |
| Native host-store unit tests | 11 total pass, including four new tests covering original-file ranges, inline nodes, publication/serving withdrawal, changed files/index mismatch and corrupted content |
| Fixture provider regression | Real Atlas signed discovery, header reads, grants, descendant checks, repeat reads and corruption rejection pass over TCP and UDP |
| Actual-server native probes | TCP and UDP: six signed offers, verified `ATLAS001` header, 37 verified blobs / 131,095 payload bytes including repeated reads |
| Shared renderer/input/raster tests | 7 pass, 55 assertions |
| TypeScript | Root `bun run typecheck` passes |
| Android build | App and instrumentation APKs build; lint: 0 errors, 39 warnings |
| APK validation | Signature v2 verifies; 16 KiB zip alignment passes |
| Automatic server connection | Cleared only this app's settings, launched without a config intent, loaded Lower Rhine East through bundled server TCP pins |
| Native map picker | Switched through all six maps over TCP; East, West and Netherlands over UDP; no new connection settings required |
| Display-layer choices | Disabled all selected layers, zoomed, observed 0/0 tiles and no additional verified package bytes; enabling layers resumed loading. Tested both geometry and imagery |
| UDP touch gestures | Real injected pan and two-pointer pinch on Netherlands imagery: zoom 6.87 → 8.47, changed center, then 6/6 raster tiles |
| TCP touch gestures | Lower Rhine West: zoom 7.25 → 8.84, changed center, then 10/10 tiles and 74,441 triangles |
| Lifecycle, both carriers | Background/foreground, explicit cancel/reconnect and Wi-Fi loss/restoration all reauthenticated and loaded the selected map |
| Legacy manifest compatibility | Liechtenstein omits `tileLayers`; its geometry and six layer switches still work |
| Production isolation | `atlas.service` remained active with PID 1318650 and zero restarts; North Sea remained running at about 34% of final assembly |

The six-map TCP tour used **14,995,115 verified payload bytes / 307 blobs**,
including directory/tree reads and the layer-toggle check. Archive sizes above
are not download sizes. Counts exclude transport/encryption overhead and are not
an Internet throughput benchmark. Routing, labels, search and analysis stay off.

An initial Wi-Fi acceptance check missed a close event because it compared
successive snapshots of logcat's rotating ring. The harness now captures a
continuous log. The repeat recorded `closed Network disconnected`, authenticated
again after Wi-Fi restoration and reached 4/4 Netherlands tiles. No application
network policy was weakened to make the test pass.

Evidence stays in ignored `output/`: `server-probe-tcp.log`,
`server-probe-udp.log`, and `phone/hosted-tcp`, `hosted-udp-recovery`,
`hosted-gestures-udp`, `hosted-gestures-tcp`, `hosted-final`, `picker-local` logs, UI snapshots and
screenshots. Failed
acceptance attempts are not counted as passes. Physical map screenshots were
visually inspected. See [README.md](README.md) for reproducible commands.

The LAN firewall rules were opened by the administrator without restarting
Atlas. They are runtime rules and will disappear on a firewall rebuild/restart.
`native/lan-firewall.nix` is prepared and syntax-checked, but has **not** been
applied. Import it during the next approved NixOS update. The separate native
sidecar services are enabled; the prior main-server release remains staged.

## Earlier Liechtenstein fixture acceptance

These results below used the previous APK and a native provider on the development
computer, with `data/liechtenstein.atlas` (30,811,870 bytes; root
`faeb9e03f4db9615d9114a85fc4445365fd3ac0a6aa4316622993a6e85c94b91`).
They remain evidence for the unchanged authentication/corruption paths, not
claims that production files were deliberately corrupted. Previous APK SHA-256:
`c2b9a8a35311cf1fce788febd55b63946fcb7322240e236cebc9538a6a6381f4`.

| Check | Result |
| --- | --- |
| Native unit tests (before host adapter) | 7 pass: original response/carrier/cancellation tests plus signed discovery, grants, descendants, corruption, expiry and malformed-tree checks |
| Retained native process tests | 5 pass: real TCP/UDP transfers, missing content, bad hashes, mismatched peer identity, no hostname/WS fallback |
| Real Atlas provider acceptance | TCP and UDP pass: signed catalog, real `ATLAS001` header, grant/membership denials, 36 verified reads per probe, repeated consumers, stable pins/catalog across restart, corrupt map rejection |
| Shared map input regressions | 2 pass: pinch midpoint scaling, pan after pinch, cancellation, no accidental click, existing mouse and tap behavior |
| TypeScript | Root `bun run typecheck` passes |
| Android build | ARM64 debug APK assembles; instrumentation APK builds; lint: 0 errors, 37 warnings |
| APK validation | Signature v2 verifies; `zipalign -c -P 16 4` passes |
| Physical TCP map | Automatic discovery and geometry render: 7/7 tiles, 166,947 triangles, 860,945 verified payload bytes in 16 blobs |
| Physical UDP map | Same view and verified byte count as TCP |
| No manual connection | Clearing only the new app's settings and launching without a config intent loads the bundled demo map automatically |
| Pan and pinch, both carriers | Genuine injected two-pointer gestures change center and zoom from 11.08 to 12.67; new view reaches 5/5 tiles and 257,002 triangles |
| Background/resume, both carriers | Home closes native connection; foreground authenticates again and reloads without Connect/Open taps |
| Explicit disconnect, both carriers | Cancels session, remains disconnected, then explicit Reconnect succeeds |
| Pending authentication cancellation | Physical unreachable-peer attempt cancels promptly through the UI |
| Wi-Fi loss/restoration, both carriers | Native session closes on network loss/change; Wi-Fi restored in test cleanup; foreground map reconnects automatically |
| Unavailable peers, both carriers | Actionable 25-second native timeout; no success view or fallback |
| Corrupt map bytes, both carriers | Signed discovery succeeds, deliberately altered map blob fails SHA-256; map never renders |
| Visual inspection | Physical-device map screenshots inspected, including geometry after pinch |

Payload byte counts include catalog/tree content and exclude transport overhead.
They are evidence of selective reads, not an Internet throughput benchmark. The
initial view used about 2.8% of this map's bytes. Gesture runs reached 1,712,913
verified bytes across 29 blobs. Geometry-only startup excludes labels, routing,
search and feature extraction; their directory metadata can still describe them.

The first gesture acceptance exposed a missing pinch implementation in the
shared MapInput: it treated the second finger as another drag. The input handler
now uses the two-pointer midpoint and logarithmic distance ratio. Physical
acceptance passed after that change. A native provider slot leak was also fixed:
completed application transfers no longer fill all eight serving slots.

Evidence is stored locally in ignored `output/phone/`: `tcp-final`, `udp-final`,
`default-final`, `gestures-tcp`, `gestures-udp`, `cancel-pending`,
`unavailable-tcp`, `unavailable-udp`, `corrupted-tcp-final`,
`corrupted-udp-final` logs, UI snapshots and screenshots. No device logs, keys,
map exports or APKs are committed. Use [README.md](README.md) to reproduce.

## Remaining limits

- Discovery is the signed, hash-pinned `atlas-native-v1` snapshot profile, not
  live relay discovery or the finalized shell contract. A changed library or
  seven-day catalog expiry requires refreshing public connection configuration.
  Server reads honor publication/serving withdrawal; the picker is a snapshot.
- This is a separate native provider reading production files, not native ingress
  into the TypeScript process. Internet/cellular reachability, NAT traversal,
  controlled packet loss and prolonged sessions remain unverified.
- The viewer selects one map at a time. Multi-provider composition, signed
  hoster default views and failover are not implemented here. Reconnect resets
  the viewport and memory cache. Session cancellation closes all work; individual
  already-queued native reads are not cancelled separately.
- Native root grants authorize verified descendants. Layer selection governs the
  trusted renderer's reads, not a per-family security ACL.
- Other Android versions/models have not been physically retested. Original
  emulator evidence is historical, not a new emulator run.
- The debug app accepts public config through an Android intent for acceptance;
  it is not a general production shell permission model. Lint warnings concern
  localization, ABI/data-extraction configuration, layouts and tool updates;
  there are no suppressed lint errors.

The original demo checkout and installed app remain intact. No private source,
keys, device artifacts or APKs are committed or published. Production Atlas was
not restarted, and its staged update was not activated during these tests.

## Server-only public entry extension — 11 November 2026

The native provider now keeps its LAN bootstrap and additionally joins an
identity-pinned public UDP entry. Public probes with independent consumer
identities selected Lower Rhine East and West from six signed offers, validated
root grants/descendants and `ATLAS001` headers, and each completed 36 verified
blob reads (131,095 and 127,993 payload bytes respectively). Both probes used
only the public entry endpoint and map host npub. Retained LAN TCP reads passed.
Fourteen native unit tests and the extended isolated dual-entry mesh suite passed.

This is public-entry route verification, not physical cellular acceptance. No
phone build/profile was changed in this server-only rollout. The installed APK
still selects its LAN entry. The native public profile uses UDP only and one
external entry; TCP WAN availability and automatic client failover are not
claimed. See [public hosting](../../docs/NATIVE-FIPS-HOSTING.md) for reproduction.
