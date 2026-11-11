# Atlas Android acceptance — 2026-11-11

Branch: `codex/android-atlas-native-fips`. The module was migrated without shell
history from napplet-space `d00ec1ea657c279c120de2c25f071298d17ecfdc`.
[Original transport-demo evidence](TRANSPORT-VERIFICATION.md) is retained as a
historical report, not a claim that every old emulator check was rerun here.

## Deliverable and real source

- APK: `output/atlas-native-viewer.apk` (16,025,754 bytes, ARM64 debug build).
- Application ID: `org.atlas.nativeviewer`; original `soy.napplet.fipsdemo` retained.
- Physical device: Pixel 10 Pro XL, Android 17, connected by USB for installation,
  test input and logs. **Map bytes used LAN Wi-Fi, not USB or adb forwarding.**
- Real map: repository `data/liechtenstein.atlas`, 30,811,870 bytes, exported as
  476 Hashtree blocks. Root:
  `faeb9e03f4db9615d9114a85fc4445365fd3ac0a6aa4316622993a6e85c94b91`.
- Independent native provider on a development computer. No production server,
  WebSocket provider or HTTP proxy participates in these phone tests.

APK SHA-256:

```text
c2b9a8a35311cf1fce788febd55b63946fcb7322240e236cebc9538a6a6381f4
```

## Observed results

| Check | Result |
| --- | --- |
| Native unit tests | 7 pass: original response/carrier/cancellation tests plus signed discovery, grants, descendants, corruption, expiry and malformed-tree checks |
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
  production Nostr relay discovery. No live revocation/revision feed or finalized
  native provider descriptor is implemented. Catalog expiry needs fresh public
  configuration. See [architecture](../../docs/ANDROID-NATIVE-FIPS.md).
- This is an isolated native provider path, not native ingress into the deployed
  TypeScript service. Internet/cellular reachability, NAT traversal, controlled
  packet loss, prolonged sessions and large regional files are not accepted yet.
- The viewer grants one map root, without multi-provider composition. Reconnect
  resets its viewport and memory cache. Individual native queued reads are not
  cancelled separately; session cancellation closes the endpoint.
- Android 11–16 and other phone models are build-supported but not device-tested
  in this pass. The migrated legacy emulator script is retained and retargeted;
  the original emulator evidence is historical, not a new emulator run.
- The debug test app accepts public config through an Android intent for the
  acceptance harness. It is not a general production shell permission model.
- Lint warnings concern English-only strings, ChromeOS x86 ABI, data-extraction
  rules and an available Gradle plugin update. No lint errors are suppressed.

The original demo checkout and installed app remain available. Android work did
not restart/deploy production or publish source. Separately authorized preceding
server changes were validated and staged, but activation was deferred at the
user's request while North Sea continued building.
