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

Keep the tunnel command running and open **http://127.0.0.1:13100/** or
**http://127.0.0.1:13100/host**. Port 13100 avoids the Mac development server on 3100.
SSH forwards to the remote server, so the data and tools actually run on the HM90S.
Localhost also supports the browser secure-context APIs used for hashing, persistent
caches and service workers. Plain `http://192.168.0.179:3100` is not an equivalent
browser environment. Direct LAN use needs trusted HTTPS for the full client demo.

Flags accept `--name value` or `--name=value`; run `bun run deploy --help`.
`--host`, `--root`, `--port`, `--local-port` customize the target.
`--upload-mib 8` optionally limits transfers on a congested Wi-Fi connection.
`--format=json` emits a structured result; build progress goes to stderr.

## What is deployed

The current working tree, including uncommitted tracked changes and non-ignored
new files. Git commit and dirty status are recorded, and every staged file receives
a SHA-256 checksum verified after upload. No Git remote/push is needed. A local
snapshot is taken after checks/builds; avoid editing while it is being staged.

Excluded even if tracked: `.git`, environment files, private-key extensions,
local agent/credential directories, `node_modules`, native `target`, `dist` and
`data`. Portable WASM is rebuilt locally and explicitly included. Linux native
importers are compiled on the target; Mac executables are never transferred.
Code should never contain credentials; the exclusion list is not a secret scanner.

Default checks: TypeScript, Bun tests, Rust tests, WASM build and web build.
`--skip-checks` skips the test/typecheck stage only; both asset builds still run.
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
host state. Checks cover health/release identity, frontend/WASM assets, the catalog,
an actual 206 byte-range response and native preparation tool availability.

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

## One-time NixOS integration

The deploy command needs no sudo. It starts/enables a user unit immediately.
Without lingering, automatic startup depends on the user's login session; the
machine currently auto-logs into GNOME, but this should not be the long-term dependency.

`deploy/nixos.nix` is a small optional module that enables lingering for `nixuser`
and allows port 3100 from `192.168.0.0/24` only. Install a fixed copy under `/etc/nixos`
and add it to the existing imports, preserving the current model-server settings:

```sh
ssh -t nixuser@192.168.0.179
sudo cp /home/nixuser/atlas/current/deploy/nixos.nix /etc/nixos/atlas.nix
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

## Live validation record — 2026-10-10

Local verification passed: TypeScript, 117 Bun tests and 42 native Rust tests,
plus both portable WASM builds and the frontend build. Resume/rate-limit changes
also passed focused CLI tests and TypeScript. The Nix runtime was actually built
on the HM90S (Bun 1.3.13, Rust/Cargo 1.95.0, Osmium 1.19.1). The optional NixOS
module was evaluated against the live configuration without applying it; it kept
the existing model-server firewall rule and enabled the proposed Atlas rule/linger.

The first 5.57 GiB deployment was interrupted during upload. Three regional
archives and the base file arrived, with the fourth partially transferred.
No Atlas service was activated. Model serving was still active on the last
successful check. Candidate startup, code-only update and rollback remain to be
verified on this host once the network is stable.

During a disconnect, the Mac resolved `192.168.0.179` to the server's Wi-Fi MAC
`10:6f:d9:76:0b:f3`, while its Ethernet MAC is `1c:83:41:32:c2:53`. This is evidence
of an interface/addressing issue consistent with ARP flux, not a confirmed complete
network diagnosis. Ethernet-only operation or an explicit multi-interface ARP
policy should be checked before more large transfers. Network changes were not
made as part of deployment. See the kernel's
[ARP behavior documentation](https://kernel.org/doc/html/latest/networking/ip-sysctl.html).

The unfinished release ID is `20261010T064147309Z-a495dbcf1785-38a9b710`.
After checking that no upload/activation remains active and clearing any abandoned
`.deploy-lock`, resume with:

```sh
bun run deploy --map data/vienna-plus.atlas --with-library \
  --resume 20261010T064147309Z-a495dbcf1785-38a9b710 --upload-mib 8
```
