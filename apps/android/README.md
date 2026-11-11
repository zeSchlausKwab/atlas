> Migrated into Atlas from napplet-space commit `d00ec1ea657c279c120de2c25f071298d17ecfdc` (`codex/android-fips-demo`). The original source is retained. This document and VERIFICATION.md initially describe the source demo; Atlas viewer instructions and new acceptance evidence will be added separately.

# Native FIPS Android demo

A small Android app that fetches a public Hashtree blob through **native UDP or
TCP sockets**, authenticates a pinned FIPS peer, and verifies the content's
SHA-256 before displaying it. Includes a companion desktop peer and CLI client.

The Android app uses Java → JNI → embedded Rust FIPS. It contains no WebView,
browser fetch bridge, VPN/TUN interface, WebSocket fallback, STUN or TURN client.
Both endpoints use numeric IP addresses and fresh in-memory identities. Nostr,
LAN/mDNS and local rendezvous discovery are disabled. Each transfer closes its
endpoint when it finishes, fails, is cancelled or the activity leaves the
foreground; there is no background service or persistent wallet/account identity.

This is an isolated transport demonstration, **not a mobile napplet shell or an
Atlas map viewer**. The app talks directly to its companion peer. A server/peer
still supplies the bytes. It does not turn an Android browser into a TCP client,
prove NAT traversal between two phones, or remove the need for reachable peers.

## Build and install

Requirements: JDK 17+, Android SDK platform 36, NDK 29.0.14206865, Rust with
`aarch64-linux-android`, Python 3 for the local acceptance suite. Tested with
Gradle 8.14.3 (checksum pinned) and Android Gradle Plugin 8.11.0.

```sh
rustup target add aarch64-linux-android
export ANDROID_HOME=/path/to/Android/sdk
export JAVA_HOME=/path/to/jdk
bash scripts/build-android.sh
adb install -r output/native-fips-demo.apk
```

The debug APK supports **64-bit ARM devices on Android 11+**. It is signed with
the local Android debug key. The script builds JNI first, then assembles and lints
the APK; invoking Gradle alone will not compile the Rust library. The native
library and APK use 16 KiB-compatible page alignment.

## Try it on a phone

On a computer reachable from the phone's Wi-Fi network:

```sh
cargo build --manifest-path native/Cargo.toml --locked --bin fips-demo
# Replace 192.168.1.20 with the computer's LAN IP. Allow UDP 42121 locally.
native/target/debug/fips-demo serve udp 0.0.0.0:42121 192.168.1.20:42121
```

1. Copy the single JSON line printed by the peer. It contains only public
   connection details: transport, IP:port, peer identity and content hash.
2. Open **Native FIPS** → **Paste connection details** → **Use details**.
3. Tap **Connect & verify**. The app shows authentication, transfer progress,
   native carrier, verified byte count and elapsed time.
4. To compare TCP, stop the peer with Ctrl-C and repeat with `serve tcp`.
   Its identity changes on restart, so copy the new JSON. Allow TCP 42121 locally.

The synthetic fixture is about 263 KiB and contains no personal or Atlas data.
It binds only to loopback when no address is supplied. The explicit wildcard
above makes this test fixture reachable on the LAN. Stop it when finished.
The app requires a literal IP; for IPv6 use `[address]:port`.

### Android emulator

The standard emulator reaches its computer at `10.0.2.2`:

```sh
native/target/debug/fips-demo serve udp 127.0.0.1:42121 10.0.2.2:42121
```

Paste the emitted JSON into the app. Alternatively pass the same public JSON in
the `config` string extra to `soy.napplet.fipsdemo/.MainActivity` with `adb shell
am start`. This only fills the form; it never starts a connection automatically.

## Architecture and protocol boundary

```text
Android UI → JNI → native FIPS endpoint
                      │
                direct TCP or UDP
                      │
                companion FIPS peer
                      │
                Hashtree blob service
```

The outer carrier is real operating-system TCP or UDP. Inside either carrier,
the Hashtree service uses the same reliable **TCP/FIPS** stream framing as the
browser integration, on FIPS service port **39018**. That service port is
independent of the physical listener port (42121 in these examples).

The client requests exactly the supplied hash with HTL 0 (local content only),
validates response framing and size, then checks SHA-256. Its 2 MiB resource bound
and 25-second transfer deadline are local demo policy. Invalid, missing, truncated
or corrupt responses cannot produce a successful preview. There is no download
URL or silent transport fallback. The caller must obtain the peer identity and
hash from a trusted source; the demo does not discover signed resource offers.

Native pins: `nvpn-fips-core` **0.4.95**, `nvpn-fips-tcp` **0.2.5**,
`nvpn-fips-tcp-endpoint` **0.2.30**, with Cargo.lock committed. This is the Nostr VPN
FIPS implementation, not an arbitrary build of another FIPS fork. Blob framing
matches the MIT-licensed `@hashtree/fips-transport` 0.5.0 reference already vendored
in `packages/runtime/src/fips/vendor/tcpBlobTransport.ts`.

The current Atlas provider runs the TypeScript WebSocket transport. Connecting
this native client to that provider needs a compatible TCP/UDP ingress peer with
a route to it, or a native transport added to the provider. This demo makes neither
change and does not contact, restart or deploy Atlas. It introduces no new NAP or
napplet-visible network privilege. A future mobile shell should keep native FIPS
in the host and expose the existing resource boundary to sandboxed napplets.

## Verification

```sh
cargo test --manifest-path native/Cargo.toml --locked --lib
cargo build --manifest-path native/Cargo.toml --locked --bin fips-demo
python3 scripts/test-transports.py
```

The process tests run real TCP and UDP peers, verified transfers, missing content,
corrupt content, mismatched peer identity, and rejection of hostnames/WebSocket
configuration. Unit tests cover response bounds, disabled discovery/system
networking, and cancellation. Android acceptance and remaining hardware checks
are recorded in [VERIFICATION.md](VERIFICATION.md).
