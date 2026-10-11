# Deploying Atlas to the NixOS demo server

Default target: `nixuser@192.168.0.179`, root `/home/nixuser/atlas`, port 3100.
SSH uses the normal client configuration/keys. Port 8080 and llama-cpp are independent.

## Commands from the Mac

```sh
# Read-only: no builds, uploads or server contact.
bun run deploy --dry-run --map data/vienna-plus.atlas --with-library

# First release: choose a base map; optionally include ready host-library maps.
bun run deploy --map data/vienna-plus.atlas --with-library

# Subsequent releases: current code, retaining all server data.
bun run deploy

bun run deploy status
bun run deploy logs
bun run deploy rollback
bun run deploy tunnel
```

Start the separate client with `bun run dev` and open **http://127.0.0.1:5173/**.
It connects directly to **http://192.168.0.179:3100/** after the LAN firewall setup
below. The server root returns service metadata, not the consumer app. The client
remains hosted on localhost so browser hashing, persistent caches and service
workers have a secure context; data and optional computations run on the HM90S.

For administration only, keep `bun run deploy tunnel` running and open
**http://127.0.0.1:13100/host**. The demo also explicitly enables the trusted LAN
host console at **http://192.168.0.179:3100/host** using the settings below. HTTPS is needed if the client website itself
is later hosted on a non-loopback LAN address.

Flags accept `--name value` or `--name=value`; run `bun run deploy --help`.
`--host`, `--root`, `--port`, `--local-port` customize the target.
`--upload-mib 8` optionally limits transfers on a congested Wi-Fi connection.
`--format=json` emits a structured result; build progress goes to stderr.

## What is deployed

The server portion of the current working tree, including uncommitted tracked
changes and non-ignored new files. `apps/web/` is excluded; the consumer is built
and hosted independently. `apps/host/`, shared libraries and server code are included. Git commit and dirty status are recorded, and every staged file receives
a SHA-256 checksum verified after upload. No Git remote/push is needed. A local
snapshot is taken after checks/builds; avoid editing while it is being staged.

Excluded even if tracked: `.git`, environment files, private-key extensions,
local agent/credential directories, `node_modules`, native `target`, `dist` and
`data`. Portable WASM is rebuilt locally and explicitly included. Linux native
importers are compiled on the target; Mac executables are never transferred.
Code should never contain credentials; the exclusion list is not a secret scanner.

Default checks: TypeScript, Bun tests, Rust tests, WASM build and host-console build.
`--skip-checks` skips the test/typecheck stage only; WASM and host assets still build.
The target builds `dist/host` before smoke checks. Server startup never builds the client.
Use it only after those checks have already passed for the same changes.

`--map` explicitly uploads a selected Atlas base map into content-addressed storage.
`--with-library` copies ready `.atlas` files and their preparation records from
`data/hosted`. It adds missing IDs and rejects conflicting contents. It never
deletes the server's library or uploads source PBFs, build workspaces, host policy,
or local environment secrets. Reusing the flags uploads them again; code-only
deploys avoid this. Large map staging temporarily needs additional local disk space.

## Server layout

```text
/home/nixuser/atlas/
  current -> releases/<release-id>
  previous -> releases/<previous-id>
  releases/<release-id>/       source, Linux dependencies, portable WASM
    .runtime -> /nix/store/... immutable runtime, protected from Nix GC
    target/                    release-specific Linux binaries/build cache
    deploy/manifest.json       checksums, revision, dirty status
    deploy/settings.json      selected map and service settings
  shared/
    maps/<sha256>.atlas        base snapshots
    data/hosted/               prepared maps, job records, source cache/work
    data/host-policy.json      persistent operation policy
    server.env                optional environment settings/secrets, mode 0600
```

`ATLAS_DATA_DIR` separates mutable state from release code. `ATLAS_FILE` chooses
the base map. The service sets these, `ATLAS_RELEASE`, `HOST`, `PORT`, `PATH` and
`CARGO_BUILD_JOBS` from its release; other environment settings can be placed in
`shared/server.env`. ContextVM stays disabled unless explicitly configured there.

The Nix runtime uses the target's installed `<nixpkgs>` channel. Each release keeps
the resolved store path, so rollback uses that release's runtime. A later NixOS
channel update can change the runtime of the next deployment. Bun and Cargo
dependencies use their checked-in lockfiles. This is not a fully hermetic build:
network dependency caches and the host channel are inputs too.

## Activation and rollback

An exclusive deployment lock serializes code switches and rollbacks. Process-held
locks also protect the upload receiver and activation if an SSH connection dies. The candidate
is checksum-verified, dependencies installed and native tools built in a resource
limited scope. Native binaries stay inside each release so building a candidate
cannot replace tools used by a live preparation or rollback. It starts on an ephemeral loopback port with separate temporary
host state. Checks cover health/release identity, host-console/WASM assets, the catalog,
an actual 206 byte-range response, public CORS preflight and native preparation tool
availability. They also confirm that consumer assets are absent from the server.
Smoke checks retain support for rolling back to earlier combined releases.

Before switching, a short maintenance marker blocks new administrative writes.
If a preparation is running/cancelling, deployment refuses to restart it. The
`current` symlink switches atomically and `atlas.service` restarts. Health must
report the new release ID; failure restores the old code and unit. This involves
a short serving interruption; it is not a zero-downtime proxy switch.

Rollback switches code and its base-map selection, never deletes shared maps or
reverts data changes. Future incompatible state/format migrations need their own
backup/migration design. Candidate smoke tests are not full route/performance tests.
Completed and failed releases are retained for inspection. Remove old release
directories and their Nix GC roots only after checking current/previous references;
automatic pruning is not implemented. An interrupted SSH client can leave
`.deploy-lock` or a maintenance marker; verify no deployment is active before
removing them. Failed uploads remain in the unused release directory. SSH keepalives detect a
lost connection and uploads retry three times. Both rsync ends enforce a 60-second
I/O timeout so a disconnected receiver releases its process lock. To resume later, repeat the original
options with `--resume RELEASE_ID` from the failure message. Checksum comparison
and rsync partial files avoid retransferring completed data. An activated/current/
previous release cannot be resumed in place. Removed source files are also removed
from the unused candidate; shared map data is outside this synchronization root. A resumed attempt keeps its original
ID but records the current source revision and file checksums in its new manifest.

## LAN firewall setup

`deploy/lan.nix` allows inbound IPv4 TCP 3100 only on Ethernet interface `eno1`
from `192.168.0.0/24`. It leaves SSH, the model service and existing administrative
restrictions unchanged. It does not enable Wi-Fi or open the port globally.

The prepared server directory is `/home/nixuser/atlas-lan-setup/`, containing the
module, `enable-lan.sh` and the inspected configuration's SHA-256. Apply it once:

```sh
ssh -t nixuser@192.168.0.179 'sudo bash /home/nixuser/atlas-lan-setup/enable-lan.sh'
```

Enter the server's sudo password in that terminal. Passwordless SSH alone does not
permit firewall changes. The installer refuses a changed configuration or conflicting
module, keeps a backup under `/etc/nixos/atlas-lan-backup.*`, adds `./atlas-lan.nix`
to imports and runs `nixos-rebuild switch`. On failure it restores the old files
and attempts to reactivate the previous system. The module persists across reboots.
The merged NixOS firewall configuration was evaluated before application and retains
the existing LAN-only port 8080 rule.

For a fresh setup, copy `deploy/lan.nix` and `deploy/enable-lan.sh` into that directory
and record the current `sha256sum /etc/nixos/configuration.nix` (hash only) as
`configuration.sha256`, after inspecting the live configuration. The script supports
the current server's single-line `imports` declaration and refuses other layouts.

After activation, `curl http://192.168.0.179:3100/health` from the Mac should report
`atlas-server`. The client's built `/client-config.json` defaults to that direct
address. Existing `?server=...` overrides and saved composition links retain their
explicit origins; use **Client composer → Primary map server → Connect to server**
to replace an old tunneled composition.

## One-time NixOS integration

The deploy command needs no sudo. It starts/enables a user unit immediately.
Without lingering, automatic startup depends on the user's login session; the
machine currently auto-logs into GNOME, but this should not be the long-term dependency.

`deploy/nixos.nix` is a small optional module that enables lingering for `nixuser`
and imports `lan.nix` to allow port 3100 from `192.168.0.0/24` on `eno1` only.
Choose this combined module instead of also importing `atlas-lan.nix`; do not
install the same firewall rule twice. Install a fixed copy under `/etc/nixos`
and add it to the existing imports, preserving the current model-server settings:

```sh
ssh -t nixuser@192.168.0.179
sudo cp /home/nixuser/atlas/current/deploy/nixos.nix /etc/nixos/atlas.nix
sudo cp /home/nixuser/atlas/current/deploy/lan.nix /etc/nixos/lan.nix
sudoedit /etc/nixos/configuration.nix
# Add ./atlas.nix to imports, alongside hardware-configuration.nix and cleanup.nix.
sudo nixos-rebuild test
# Verify existing model service, SSH and Atlas before persisting:
sudo nixos-rebuild switch
```

These steps require the user's interactive sudo password. Routine deploys do not
edit `/etc/nixos`, enable lingering, open firewall ports or touch llama-cpp. The
SSH tunnel works without the optional firewall change. Administrative endpoints
remain localhost-only; adding a firewall rule does not grant LAN host-console access.
Authenticated HTTPS administration is a future demo slice.

Resource defaults are documented in [the demo roadmap](DEMO-ROADMAP.md).
Sources: [NixOS manual](https://nixos.org/manual/nixos/stable/),
[Bun locked installs](https://bun.com/docs/pm/cli/install).

## Initial deployment validation — 2026-10-10

Local verification passed: TypeScript, 117 Bun tests and 42 native Rust tests,
plus both portable WASM builds and the frontend build. Deployment hardening also
passed focused CLI tests (5 tests, 48 assertions) and TypeScript. The Nix runtime
was built on the HM90S: Bun 1.3.13, Rust/Cargo 1.95.0, Osmium 1.19.1.

The first deployment is complete: 5.57 GiB comprising Vienna Plus and four ready
regional maps. A second, code-only deployment transferred 1,806,700 bytes of files,
imported no maps and became healthy. Rollback to the first release and restoration
of the second both passed. All five map files retained their inode, size and mtime.
A deliberately invalid map was rejected by candidate startup before activation;
the healthy release and previous-release pointer stayed unchanged.

Application release at this initial check: `20261010T071011743Z-1f66b300a009-43b82f22`
(source revision `1f66b300a009`). First/previous release:
`20261010T064147309Z-a495dbcf1785-38a9b710` (source revision `e00a6f38c7b1`).
The failed disposable-map candidate is retained for inspection at
`releases/20261010T071249405Z-1f66b300a009-abb4b320`; it is not served.
Later documentation commits do not change the running application code.

Verified on the server: UI/WASM assets, catalog, 206 byte ranges, native preparation
prerequisites, a server-executed peak query through HTTP, and generation/inspection
of the transport PBF fixture. That fixture
produced a 7,108-byte Atlas file with 11 blocks and walking/cycling/driving graphs,
including its driving turn restriction. The browser host console lists all four
ready maps and server disk capacity. The normal viewer renders their composition
and completed a Vienna–Bratislava client route; see [the baseline](DEMO-BASELINE.md).

At the final deployment check, Atlas was active, its service cgroup used about
84 MiB, and about 393.4 GiB remained free. These are idle/small-fixture observations,
not memory bounds for server routing or regional preparation. The original llama-cpp service
was active throughout deployment/rollback checks. At 09:13:37 CEST a separate NixOS
administration change stopped and removed that unit; the final check found
`lemond.service` active (Lemonade model manager) and port 8080 listening. Atlas did
not change either model service or `/etc/nixos`. ContextVM remains unconfigured. No Europe/planet download was started.

### Ethernet-only recovery

The Mac had resolved `192.168.0.179` to Wi-Fi MAC `10:6f:d9:76:0b:f3`, while
Ethernet uses `1c:83:41:32:c2:53`. Clearing the stale entry alone immediately
rediscovered the Wi-Fi MAC. A temporary, authenticated Mac ARP entry using the
verified Ethernet MAC restored SSH. After explicit user approval, `nmcli radio
wifi off` disabled the server radio. NetworkManager persisted `WirelessEnabled=false`;
`eno1` retained `192.168.0.179/24` and the sole default route. The temporary Mac
entry was removed, normal discovery returned the Ethernet MAC, and deployment
and subsequent checks completed reliably. No persistent Mac override remains.
See the kernel's [ARP behavior documentation](https://kernel.org/doc/html/latest/networking/ip-sysctl.html).

At this initial check, the optional NixOS module had only been evaluated and
port 3100 was closed to the LAN. The later activation below supersedes that state.
Lingering remains off; its optional setup is separate from the firewall change.

### Direct LAN activation — 2026-10-10

The user applied the prepared installer with interactive sudo. The live configuration
now imports `/etc/nixos/atlas-lan.nix`, limiting TCP 3100 to `192.168.0.0/24` on
`eno1`. Direct requests from the Mac returned a healthy `atlas-server` and a valid
206 response for a 32-byte map range, with CORS and package identity headers.
Atlas and the existing `lemond.service` both remained active.

The independent client at `http://127.0.0.1:5173/` was rebuilt with the LAN default
and its composition reconnected to `http://192.168.0.179:3100/`. All four regional
maps rendered, and a server search completed over this direct connection.
See [the client verification record](SERVER-CLIENT.md#direct-lan-verification--2026-10-10).
The running server release is `20261010T073750336Z-f520fc89760e-9a59f406`; this
firewall/client configuration change required no server application redeployment.
The SSH tunnel remains optional for the loopback-only host administration console.


## Host console and source workers

Persistent server settings in `/home/nixuser/atlas/shared/server.env`:

```ini
ATLAS_ADMIN_ORIGINS=http://192.168.0.179:3100
ATLAS_ADMIN_SUBNETS=192.168.0.0/24
ATLAS_SOURCE_SYSTEMD=1
```

The first two settings jointly enable trusted LAN administration. They do not
trust proxy headers and do not grant cross-origin browser access. Both are needed;
unset both for local-only administration. This grants administration to clients
on the configured subnet, not individually authenticated users.

Source downloads use separate transient user units `atlas-source-<id>.service`,
with a bundled worker under shared data, a 1 GiB memory limit and lower CPU
priority. They survive a map-server deployment/restart. A machine restart retains
the partial file; use Resume download in the host console. The completed file is
published after checking the provider MD5 and recording SHA-256. Downloads retain
60 GiB free space. Source files and job/recipe records live in `shared/data/sources/`.
Partial files are reused only with exact byte-range and source identity checks.
See [Europe preparation](EUROPE-PREPARATION.md) for current compiler readiness.

## Britain workflow handoff — 2026-10-11

Deployed release `20261011T061824389Z-e68eb93fb3f3-4ba98d18` (code `e68eb93`,
following implementation `960f890`). Open
`http://192.168.0.179:3100/host?area=britain` for the cached-planet starter:
Britain-area rectangle, z0–16, 32 GiB output ceiling, editable capability preset.
The link does not start a job. The user explicitly requested manual start.
The rectangle includes parts of Ireland and neighbouring coasts; it can be replaced.

Europe job `f338f58d-7554-41c8-8424-56d841fb3d25` is cancelled with its extraction
and compiler checkpoints retained. Five prepared maps remain available. The
verified 88.7 GiB planet stays cached. Atlas and the independent Lemond model
service are active. About 244.7 GiB was free after deployment.

Validation: 147 Bun tests, TypeScript check, host bundle and deployment candidate
smoke checks pass. Browser verification covered geometry-only/all/custom presets,
Geofabrik/source switching, library-map reuse, deletion confirmation/cancellation,
source-file maintenance, and the ready Britain selection. Deletion itself was
exercised only on temporary test fixtures; no existing LAN dataset was deleted.
