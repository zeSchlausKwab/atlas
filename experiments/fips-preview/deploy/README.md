# Deploy only the FIPS preview provider

Run `python3 deploy/deploy.py --help`. The service name is fixed to
`atlas-fips-preview.service`; the script never manages the Atlas service.

Prerequisites: local Python 3.9+, OpenSSH, and this experiment's locked package
files; remote Bash, tar, flock, a working `systemctl --user`, Bun, npm (or Nix with
`--npm-via-nix`), outbound HTTPS for package installation and WSS for transit.
The existing Atlas source must have its dependencies installed and the selected
published SQLite index/archive must be readable. An active user manager is required;
lingering is useful for operation after logout. No sudo, firewall change, TUN,
public listener, fresh map indexing, or Atlas restart is performed.

Example (replace every path/target with your deployment's values):

```sh
python3 deploy/deploy.py \
  --host user@server \
  --root /home/user/atlas-fips-preview \
  --source-root /home/user/atlas/releases/release-id \
  --index /home/user/atlas/shared/data/hashtree/map-id.sqlite \
  --bun /absolute/path/to/bun \
  --npm-via-nix \
  --dry-run
```

Remove `--dry-run` to deploy. Use `--npm /absolute/path/to/npm` instead of
`--npm-via-nix` where npm is already available. Nix's Node package comes from the
host's `nixpkgs` registry; application dependencies are fixed by package-lock.json.
If npm's executable needs a non-default Node PATH, arrange that in the SSH login
environment or use the Nix option.

Each deployment uploads only the provider entry, provider service, dependency
manifests and validation/template files into a fresh release directory. It runs
`npm ci --ignore-scripts`, imports provider dependencies, and verifies the existing
map root before replacing the preview unit. It preserves `state/provider.key`.
An existing configuration with a different identity path is refused. Failed
activation restores the previous preview unit/configuration. Prior releases and
identity state are retained; stop the preview before removing its directory.

`atlas-fips-preview.service.in` is the rendered example: one CPU quota, low CPU/IO
priority, 256 MiB soft and 512 MiB hard memory limits. Outbound WSS seeds default to
`wss://fips1.iris.to/fips,wss://fips2.iris.to/fips`; override with `--seeds`.
Service readiness confirms a new verified descriptor, not reachability through
the public seeds. Run the separate root/client proof to verify that network path.

Copy only the public descriptor to the browser machine:

```sh
scp user@server:/home/user/atlas-fips-preview/state/descriptor.json descriptor.local.json
bun config-from-descriptor.ts descriptor.local.json 'Lower Rhine West' > config.local.json
```

The descriptor contains the provider's public peer ID, root and seeds; it has no
private key. Never copy `state/provider.key` into a client configuration. See the
parent README for the converter's options and preview startup.

Stop or inspect independently:

```sh
ssh user@server 'systemctl --user stop atlas-fips-preview.service'
ssh user@server 'journalctl --user -u atlas-fips-preview.service -n 20 --no-pager'
```

## Live status in the Atlas host console

The provider atomically writes a public `fips-status.json` snapshot every five
seconds. The default destination is `ATLAS_SOURCE_ROOT/dist/host/fips-status.json`.
The optional `ATLAS_FIPS_STATUS_PATH` overrides that destination; use the stable
current-release link so later Atlas releases receive status automatically:

```ini
ATLAS_FIPS_STATUS_PATH=/home/user/atlas/current/dist/host/fips-status.json
ATLAS_FIPS_MAP_NAME=Lower Rhine West
```

These settings belong in the provider's `preview.env`. The deployment helper
regenerates that file, so reapply optional overrides after a provider deployment
before restarting **only** `atlas-fips-preview.service`. With `--source-root`
pointing to `/home/user/atlas/current`, the default status destination already
follows the current-release link. The destination directory must exist.

Snapshots contain only public connection details and aggregate counters, with
seed credentials/query fragments removed. They omit filesystem paths, private
keys and individual connected peer identities. Write failures are logged without
stopping blob delivery; overlapping writes are coalesced. The host UI marks
snapshots older than 30 seconds as stale and exposes only local display controls:
refresh, auto-refresh interval, and copying the public descriptor.

The host server reads its built static assets for each request. A tested host-only
asset update can therefore make the FIPS tab available without restarting Atlas
or interrupting map preparation. Build assets away from the active release, back
up the existing `dist/host`, and replace only `index.html`, `host.js`, its map, and
`workbench.css` atomically. Do not run `build:host` inside the live release: its
build step deletes the output directory. Keep `fips-status.json` in place.
