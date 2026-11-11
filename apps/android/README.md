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

## Public server path

[Public native hosting](../../docs/NATIVE-FIPS-HOSTING.md) documents the deployed
outbound UDP entry, reproducible configuration and probes. It needs no Atlas DNS
or inbound forwarding. APK 0.5.0 defaults to that public UDP entry; the alternate
TCP preset remains LAN-only. A clean Pixel launch loaded a complete real map
over cellular, with Wi-Fi disabled. That cold load took about eight minutes;
see the measured limits in [verification](VERIFICATION.md).

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

Start an entry peer and a separate map provider, using the host's **existing data
directory**. Run long-lived commands in separate supervised processes:

```sh
mkdir -p /srv/atlas-native/state
chmod 700 /srv/atlas-native/state
atlas-peer gateway 0.0.0.0:42131 0.0.0.0:42132 /srv/atlas-native/state
```

Once `gateway.json` exists, create the provider's public bootstrap profile:

```sh
bun -e 'const p="/srv/atlas-native/state";const g=await Bun.file(p+"/gateway.json").json();await Bun.write(p+"/bootstrap.json",JSON.stringify({peer:g.peer,address:"127.0.0.1:42131"}));'
atlas-peer serve tcp 127.0.0.1:42141 127.0.0.1:42141 /srv/atlas-native/state --host-data /srv/atlas/data --bootstrap /srv/atlas-native/state/bootstrap.json
```

The provider connects outbound to the entry peer. No phone can dial its loopback
listener directly. Generate public client profiles, replacing the example LAN IP
with the entry peer's reachable address:

```sh
bun -e 'const p="/srv/atlas-native/state";const g=await Bun.file(p+"/gateway.json").json();const c=await Bun.file(p+"/connection-tcp.json").json();for(const [transport,port] of [["tcp",42131],["udp",42132]])await Bun.write(p+"/mesh-"+transport+".json",JSON.stringify({transport,peer:c.peer,bootstrap:{peer:g.peer,address:"192.168.1.20:"+port}}));'
```

Allow only the required physical TCP/UDP entry ports. `native/lan-firewall.nix`
is a LAN-only NixOS example; temporary firewall rules do not survive a rebuild.
Do not disable the firewall or expose host administration. The gateway and
provider can use `Restart=on-failure` and `KillSignal=SIGINT` in separate user
services. Keep their state directory and keys private and durable.

Copy **only `mesh-tcp.json` and `mesh-udp.json`** into ignored `output/`, then:

```sh
cd apps/android
ATLAS_NATIVE_CONNECTION_FILE="$PWD/output/mesh-tcp.json" \
ATLAS_NATIVE_ALTERNATE_CONNECTION_FILE="$PWD/output/mesh-udp.json" \
bash scripts/build-android.sh
adb install -r output/atlas-native-viewer.apk
```

Launch connects automatically. The **Map host · npub** field chooses whose maps
to discover; entry peer and IP are under **Advanced · network entry**. Disconnect,
choose TCP or UDP, then reconnect to change the first physical hop. Both profiles
use the same host npub. The provider's onward hop remains TCP. There is no fallback.
Version 0.4 uses a new saved-profile key so the bundled mesh profile replaces the
old demo's direct configuration on upgrade; subsequent custom choices persist.

Reconnect refreshes the signed map list, including newly published maps, without
an APK rebuild or new catalog hash. The provider reads only published, served,
ready files and denies future reads after withdrawal or FIPS disablement. It
never writes the host store or uses its private key. This native identity is
separate from the TypeScript provider's identity. These setup commands describe
the retained LAN entry; use the public UDP profile above for off-LAN access.
An npub identifies a host but still needs a reachable, authenticated entry.

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
Npub profiles fetch a fresh host-signed catalog on reconnect, including newly
published maps. Legacy direct/hash-pinned profiles require refreshed configuration
when their catalog expires. Live relay discovery remains future work. Host-backed
reads honor subsequent withdrawals; cached content cannot be recalled.

## Reproduce acceptance

```sh
cargo test --manifest-path native/Cargo.toml --locked --lib
cargo build --manifest-path native/Cargo.toml --locked --bins
python3 scripts/test-transports.py
python3 scripts/test-atlas.py --export output/provider
python3 scripts/test-mesh.py --export output/provider
python3 scripts/test-phone.py --serial YOUR_PHONE --config output/tcp.json --label tcp --lifecycle --network-change
python3 scripts/test-phone.py --serial YOUR_PHONE --config output/udp.json --label udp --lifecycle --network-change
# Against a host library: select maps through native UI and verify layers stop reads.
python3 scripts/test-phone.py --serial YOUR_PHONE --config output/server-tcp.json --label hosted-tcp --switch-map 'Lower Rhine West' --switch-map 'Satellite · Netherlands' --check-layers
```

Physical tests operate only the selected device and this isolated app. Network
acceptance temporarily disables Wi-Fi and restores it in a `finally` block.
`--bundled-default` clears **this demo app's** settings and launches without any
configuration intent, proving automatic startup from the APK's public preset.

To run the real map viewer in an emulator, opt in explicitly (the original
`test-emulator.py` still tests the synthetic transport lab):

```sh
python3 scripts/test-phone.py --serial emulator-5554 --allow-emulator \
  --config output/direct-public-tcp.json --label direct-public-tcp \
  --ready-timeout 240 --check-layers --lifecycle
python3 scripts/test-phone.py --serial emulator-5554 --allow-emulator \
  --config output/direct-public-udp.json --label direct-public-udp \
  --ready-timeout 900
```

On the tested Apple Silicon host, Emulator 36.1.9's automatic graphics backend
produced a black display despite successful native reads. Cold booting this AVD
with software OpenGL restored the display without changing the APK:

```sh
"$ANDROID_HOME/emulator/emulator" -avd Medium_Phone_API_36.1 \
  -no-snapshot -no-boot-anim -gpu swiftshader_indirect -feature -Vulkan
```

Use a reachable profile prepared for your provider. These examples require the
[temporary direct endpoint](../../docs/NATIVE-FIPS-HOSTING.md) to be active.
Emulator evidence goes to `output/emulator/`, separate from phone evidence, with
an environment JSON identifying the carrier and endpoint. The emulator uses the
host computer's network: accessing a WAN address from its LAN verifies hairpin
forwarding, **not** off-LAN cellular access. Run UI tests sequentially.

For the public-entry APK, build with public settings and test cellular explicitly:

```sh
ATLAS_NATIVE_CONNECTION_FILE="$PWD/output/public-client-udp.json" \
ATLAS_NATIVE_ALTERNATE_CONNECTION_FILE="$PWD/output/mesh-tcp.json" \
bash scripts/build-android.sh
adb install -r output/atlas-native-viewer.apk
python3 scripts/test-cellular.py --serial YOUR_PHONE --config output/public-client-udp.json
```

The public profile format is in the hosting guide. The cellular test requires a
validated mobile-data connection, clears only this isolated viewer's data, proves
automatic startup and restores the original Wi-Fi setting. Do not run another
phone UI test concurrently. It allows ten minutes for a cold viewport. Blob reads
allow 90 seconds and one timeout-only retry; cancellation remains immediate and
validation failures do not retry. There is no public TCP fallback.

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
