# Local verification — 2026-11-11

Implemented on `codex/android-fips-demo`, based on shell main `05ecf4e`.
This experiment is not part of the website build or a production deployment.

| Check | Observed result |
| --- | --- |
| Rust unit tests | 3 pass: response validation / hash integrity, carrier and discovery configuration, cancellation |
| Real process/socket tests | 5 pass, including both TCP and UDP, missing blob, corrupt content, wrong peer identity, hostname and WebSocket rejection |
| Android build | ARM64 debug APK assembled; Android lint has no errors |
| Android emulator | API 36.1 ARM64: 270,080 bytes fetched and SHA-256 verified over UDP and TCP |
| Cancel button | An unfinished connection closes and displays “Transfer cancelled”; retry remains available |
| Leave / return | Home during authentication cancels the native operation; returning does not restart it |
| APK signing | `apksigner verify` passes (local debug key, APK Signature Scheme v2) |
| 16 KiB page support | `zipalign -c -P 16 4` passes; ELF LOAD segments have 0x4000 alignment |
| Visual inspection | Emulator success screen inspected; configuration, carrier, hash and verified result visible |

The lifecycle test initially caught cancellation occurring too late in `onStop`.
Cancellation now starts in `onPause`; the final emulator suite passes all four
checks (UDP, TCP, explicit cancel, background cancel).

The final emulator runs took approximately 399 ms over UDP and 1,130 ms over TCP,
including authentication and shutdown. These are loopback/emulator observations,
**not a comparative network-performance benchmark**.

Reproduce the UI checks with an already running emulator:

```sh
python3 scripts/test-emulator.py --serial emulator-5554
```

This installs only `soy.napplet.fipsdemo`, starts temporary loopback fixture
processes, fills the app using public configuration, operates its controls and
saves screenshots/UI snapshots to ignored `output/emulator/`. It stops its
fixtures on completion. It does not start or stop the emulator itself.

Remaining limits: no physical phone, cellular network, NAT traversal, packet-loss
or network-handoff acceptance; no direct connection to the current Atlas provider
and no native map rendering. Android versions below API 36.1 are build-supported
down to API 30 but have not been device-tested. Lint still reports English-only
demo strings, absent ChromeOS x86 ABI, backup-rule guidance and an available
Gradle upgrade. No lint errors are suppressed.

Local deliverable: `output/native-fips-demo.apk` (ignored, about 15 MB).
SHA-256:

```text
8171116006e0a7a40bac4dcfb040db7bbd19627f953de13b7d9052a5b48f2dd4
```

The original checkout and unrelated files were left intact. Atlas services and
builds were not changed or restarted. Nothing was pushed or deployed.
