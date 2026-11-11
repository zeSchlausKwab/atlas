# Atlas Android viewer · native FIPS

An isolated Android Atlas viewer that opens a real `.atlas` map through a native
FIPS peer. The supplied demo APK connects and opens its configured map on launch.
Networking and authorization belong to the Android host; the existing Atlas
WASM renderer and touch controls run locally in a restricted WebView.

- Physical TCP **or** UDP, pinned peer authentication, signed map discovery,
  SHA-256 verification and native Hashtree descendant checks.
- Geometry-only default; choose a satellite archive to view imagery. No routing,
  search, extraction or labels downloaded.
- Pan, pinch, zoom buttons, fit, transfer diagnostics, cancel/disconnect,
  foreground reconnect and network-change handling.
- No HTTP map fallback, WebSocket hop, DNS lookup, STUN/TURN or VPN/TUN.
- Native sidecar can read the live host's published files and indexes directly;
  the deployed TypeScript provider and map builds remain unchanged.

This is an experimental standalone viewer, not the production napplet shell.
Read [architecture and security boundaries](../../docs/ANDROID-NATIVE-FIPS.md)
and [verified behavior and limitations](VERIFICATION.md).

## Use maps already published on an Atlas server

The **Hosted maps** button selects an archive; **Layers** chooses its available
geometry or imagery. The last selection and layer choices are remembered. Tile
reads follow the viewport and zoom. Archive sizes in the picker describe the
whole file, not the amount downloaded. This viewer selects one archive at a time.

Build the native provider on the host with `cargo build --release --locked --bin
atlas-peer` in `apps/android/native`. Linux builds of the pinned FIPS crate need
`pkg-config`, DBus development headers, libmnl, libnftnl and libclang (for bindgen),
even though this application does not enable Bluetooth, firewall management or
TUN. On Nix, expose those packages' pkg-config directories and `LIBCLANG_PATH` in
a separate build environment; do not reconfigure the running Atlas service.
The supplied `native/shell.nix` keeps those C-library versions consistent:
`nix-shell apps/android/native/shell.nix --run 'cargo build --manifest-path
apps/android/native/Cargo.toml --release --locked --bin atlas-peer -j 1'`.
Keep a GC root for the resulting build environment if deploying its binary.

Start two independent sidecars, using the host's **existing data directory**:

```sh
mkdir -p /srv/atlas-native/state
# Replace addresses and paths with the actual server values.
atlas-peer serve tcp 0.0.0.0:42131 192.168.1.20:42131 /srv/atlas-native/state --host-data /srv/atlas/data
atlas-peer serve udp 0.0.0.0:42132 192.168.1.20:42132 /srv/atlas-native/state --host-data /srv/atlas/data
```

Use separate processes or supervised services, allow those physical TCP/UDP
ports, and keep the state directory private. For NixOS, `native/lan-firewall.nix`
is a LAN-only example to import during the next approved system update. Temporary
`iptables -I nixos-fw ... -j nixos-fw-accept` rules can open those same ports
without restarting Atlas, but disappear when the firewall is rebuilt/restarted.
Do not disable the firewall or enable remote host administration.

The provider writes public
`connection-tcp.json` and `connection-udp.json` there. It only reads published,
served, ready files and their indexes; disabling serving/publication/FIPS denies
further reads. It never copies map bytes, opens the host database for writing,
or reads the host's private identity. Its own keys and catalog are separate.

Copy **only the public connection JSON files** to your ignored Android output
directory, then build with both presets:

```sh
cd apps/android
ATLAS_NATIVE_CONNECTION_FILE="$PWD/output/server-tcp.json" \
ATLAS_NATIVE_ALTERNATE_CONNECTION_FILE="$PWD/output/server-udp.json" \
bash scripts/build-android.sh
adb install -r output/atlas-native-viewer.apk
```

The default connects automatically. To change carrier, disconnect, open
**Connection**, select TCP or UDP (both pinned endpoint profiles are bundled),
and reconnect. A previously saved custom connection takes precedence over the
APK default. The catalog is a pinned snapshot: newly published maps or catalog
expiry require refreshing public configuration; this is not yet live relay
discovery. The existing Atlas process needs no restart.

## Build a standalone real-map fixture

Requirements: Bun and the Atlas root dependencies, Rust with
`aarch64-linux-android`, JDK 17+, Android SDK 36, NDK **29.0.14206865**.
Gradle **8.14.3** and Android Gradle Plugin **8.11.0** are pinned. The APK supports
ARM64 Android 11+ and is signed with a local debug key.

From the Atlas repository root:

```sh
bun install --frozen-lockfile
bun run build:wasm
rustup target add aarch64-linux-android
bun apps/android/scripts/export-map.ts data/liechtenstein.atlas apps/android/output/provider
cd apps/android
cargo build --manifest-path native/Cargo.toml --locked --bins
```

The example requires an existing real Atlas file; replace the input path with
one from your map library. Export reads the source without modifying it, and
writes a Hashtree index, immutable blob files and an offer manifest. The simple
demo export duplicates the map's bytes; it is not the production zero-copy store.

Start a provider in a separate terminal, replacing the example IP with its
reachable numeric LAN address. These are **physical listener ports**, separate
from logical FIPS blob service port 39018:

```sh
cd apps/android
native/target/debug/atlas-peer serve tcp 0.0.0.0:42131 192.168.1.20:42131 output/provider > output/tcp.json
# Or a separate UDP listener:
native/target/debug/atlas-peer serve udp 0.0.0.0:42132 192.168.1.20:42132 output/provider > output/udp.json
```

Each process prints one public connection JSON object. Its stderr reports served
blobs. Keep the process running and allow the selected port on the local firewall.
There is no adb reverse, USB forwarding or HTTP proxy in the data path. The phone
must be able to reach the numeric endpoint.

```sh
export ANDROID_HOME=/path/to/Android/sdk
export JAVA_HOME=/path/to/jdk
ATLAS_NATIVE_CONNECTION_FILE="$PWD/output/tcp.json" bash scripts/build-android.sh
adb install -r output/atlas-native-viewer.apk
```

Launch **Atlas · Native FIPS**. The bundled public settings automatically connect,
verify discovery, grant the remembered map (or first map) and open it. No manual Connect/Open sequence
is required. Connection settings allow a different public JSON config and a TCP
or UDP endpoint. Settings are remembered on the device; explicit Disconnect stays
disconnected until Reconnect is chosen. Backgrounding closes native networking;
returning reconnects automatically. Building without
`ATLAS_NATIVE_CONNECTION_FILE` produces an unconfigured APK.

Only public connection settings go into the APK. Provider peer/publisher keys
are generated under `output/provider`, stored with mode 0600, and must stay
private. Keep that directory to preserve identities across provider restarts.
The signed catalog is reused while valid, but expires after seven days; a new
catalog requires refreshed public configuration. Live client discovery is future work. Host-backed reads do honor subsequent
withdrawals, as described above; cached content cannot be recalled.

## Reproduce acceptance

```sh
cargo test --manifest-path native/Cargo.toml --locked --lib
cargo build --manifest-path native/Cargo.toml --locked --bins
python3 scripts/test-transports.py
python3 scripts/test-atlas.py --export output/provider
python3 scripts/test-phone.py --serial YOUR_PHONE --config output/tcp.json --label tcp --lifecycle --network-change
python3 scripts/test-phone.py --serial YOUR_PHONE --config output/udp.json --label udp --lifecycle --network-change
# Against a host library: select maps through native UI and verify layers stop reads.
python3 scripts/test-phone.py --serial YOUR_PHONE --config output/server-tcp.json --label hosted-tcp --switch-map 'Lower Rhine West' --switch-map 'Satellite · Netherlands' --check-layers
```

Physical tests operate only the selected device and this isolated app. Network
acceptance temporarily disables Wi-Fi and restores it in a `finally` block.
`--bundled-default` clears **this demo app's** settings and launches without any
configuration intent, proving automatic startup from the APK's public preset.

For touch gestures:

```sh
./gradlew --no-daemon assembleDebugAndroidTest
python3 scripts/test-gestures.py --serial YOUR_PHONE
```

For corruption, start a separate `atlas-peer ... --corrupt` and pass its public
config to `test-phone.py --expect-error 'SHA-256 mismatch'`. For unavailable-peer
acceptance, use a copy of a valid config with an unused numeric endpoint and
`--expect-error 'timed out after 25 seconds'`. Neither test enables fallback. `--cancel-pending` with an unreachable peer tests
cancellation during authentication.
Artifacts stay in ignored `output/`.

## Migration and retained transport lab

Copied from napplet-space commit
`d00ec1ea657c279c120de2c25f071298d17ecfdc`, branch `codex/android-fips-demo`, without
importing its Git history. The migration-only commit in Atlas preserves the
original source files and instructions. The original checkout and original
installed app have been retained.

The new application ID is `org.atlas.nativeviewer`; it does not replace
`soy.napplet.fipsdemo`. The original Java `MainActivity`, synthetic `fips-demo`
peer, transport tests and emulator tests remain available. Run the retained lab
with `adb shell am start -n org.atlas.nativeviewer/soy.napplet.fipsdemo.MainActivity`.
Its operation is deliberately manual and separate from the viewer.
`test-emulator.py --serial emulator-5554` exercises that lab in the migrated APK.

Native dependency pins remain `nvpn-fips-core` **0.4.95**, `nvpn-fips-tcp`
**0.2.5**, `nvpn-fips-tcp-endpoint` **0.2.30**. See [THIRD_PARTY.md](THIRD_PARTY.md)
and the retained [MIT license](LICENSE). No shell private planning documents,
source history, provider keys, APKs or generated map data are committed.
