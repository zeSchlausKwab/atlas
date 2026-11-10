# Atlas FIPS preview experiment

This uses the real Soyli `startPreviewServer` and compiled preview runtime, adding a
parent-page FIPS client. It makes no changes to Soyli or its production NAP domains.
The napplet remains in the ordinary opaque, no-network, no-worker iframe.

Install dependencies and run with Bun from this directory:

```
npm ci
bun run preview config.local.json
```

The optional second argument selects a project; the default is `../../atlas-consumer`.
The first argument is required and names a **public** configuration JSON file.
`ATLAS_PREVIEW_PORT` defaults to 4188. `ATLAS_SOYLI_SOURCE` defaults to the sibling
`napplet-space` checkout (which must already have its dependencies installed).
`ATLAS_FIPS_MODULES` optionally overrides this experiment's installed `node_modules`.
No private key belongs in the preview configuration or browser bundle.

For repeatable remote installation, see [the sidecar deployment helper](deploy/README.md).
It stages a separate release, verifies the existing index read-only, and manages
only `atlas-fips-preview.service`. `bun run deploy --help` lists its arguments.

Configuration:

```json
{
  "seedUrls": ["wss://SEED/fips"],
  "providerPeerId": "02_OR_03_PREFIX_PLUS_64_HEX_DIGITS",
  "map": {
    "name": "Atlas map",
    "rootHash": "64_HEX_DIGITS",
    "size": 12345,
    "chunkBytes": 65536
  },
  "timeoutMs": 30000
}
```

The child posts to `window.parent` using target origin `*` (its origin is opaque):

- `{type:'atlas-preview.status', id}` → `atlas-preview.status.result`, with
  `state`, optional `error`, public `peerId`, `providerPeerId`, `seedUrls`, `map`,
  `connectedPeers`, `requestTimeoutMs`, and `stats` at the top level.
- `{type:'atlas-preview.getBlob', id, hash, providerPeerId?}` →
  `atlas-preview.getBlob.result` with a transferred `bytes: ArrayBuffer` and `stats`,
  or `atlas-preview.getBlob.error` with `error` and `stats`.
- `{type:'atlas-preview.cancel', id}` removes the pending request and suppresses
  its eventual reply. The transport API cannot cancel a single shared read.
- `atlas-preview.status.changed` is a parent notification with the status fields.

Only the actual current `#stage > iframe`, with origin `null`, can request blobs.
Requests are pinned to the configured provider. Both the underlying transport and
bridge verify SHA-256. At most eight unique reads run at once; bursts queue within
the 32 accepted child-request limit rather than failing at the ninth transfer.
Blobs are bounded to 2 MiB and the parent cache to 32 MiB. Account reloads are not
needed; replacing the child drops its requests. Page teardown closes the node.

`stats.fipsBytes` counts blob payload bytes returned by FIPS, not wire traffic.
`requests` counts accepted child reads; `networkRequests` counts uncached transport attempts, including retries.
`retries` counts automatic reattempts after transient TCP/FIPS timeouts. `activeTransfers` and `queuedTransfers` expose the concurrency
limit. `cancelledRequests` counts accepted child reads cancelled before reply;
unknown or repeated cancellations do not increase it. Pending, queue, active-slot
and cancellation changes emit status immediately, even when no blob has completed.
There is no HTTP blob fallback and no inbound blob serving.

`timeoutMs` is the FIPS transport budget, including its existing retry. A child
request also waits for a transfer slot. Status therefore advertises
`requestTimeoutMs = ceil(32 / 8) * (2 * timeoutMs + 750) + 10000`: four full
transfer waves, each allowing one additional transport read after a 750 ms pause,
plus ten seconds of grace (**253 seconds** at the default 30-second budget). This
is a worst-case queue deadline, not a delay before reporting success. The child bridge uses this total deadline; the Hashtree reader's outer
deadline must exceed it. Applying the ordinary HTTP reader's ten-second deadline
would cancel queued FIPS reads before their transport budget expires. Only known
transient TCP/FIPS connect/read/write timeouts are retried; missing blobs and
invalid bytes remain errors. Cancellation
suppresses the reply; an already shared transport read may still finish and cache
its verified result. This is a caller-side deadline: underlying serialized FIPS work can outlast its nominal transport budget.

This is a preview experiment, not a portable production napplet capability.

## Provider process

`serve-atlas.ts` mounts an existing Atlas Hashtree index on the standard FIPS blob
service port 39018. It connects outbound to WSS seeds; it does not expose a new
HTTP blob endpoint or change an existing Atlas server. Configure these environment
variables before `bun run serve`:

- `ATLAS_SOURCE_ROOT`: path to the Geo-format checkout on that host.
- `ATLAS_INDEX_PATH`: existing Hashtree SQLite index for the selected atlas.
- `ATLAS_FIPS_KEY_PATH`: private identity file stored outside this repository.
  It is created exclusively with mode 0600 if missing.
- `ATLAS_FIPS_SEEDS`: optional comma-separated WSS seeds. Defaults to
  `wss://fips1.iris.to/fips,wss://fips2.iris.to/fips`.
- `ATLAS_FIPS_DESCRIPTOR_PATH`: optional public descriptor output file.

The emitted public descriptor contains the compressed provider key, root, archive
size, chunk size and seeds. Convert it into the preview configuration:

```sh
bun run config:from-descriptor descriptor.json "Lower Rhine West" > config.local.json
bun run preview config.local.json
```

The converter accepts the original demo descriptor without `chunkBytes`, using
its known 65536-byte default. An optional final numeric argument overrides that
for a differently indexed map. SIGINT/SIGTERM stops
the FIPS service and closes the index. Provider logs count served payload bytes.

## Verification and limits

`bun test` checks the bridge's frame/provider boundary, verified cache, corrupt-blob
rejection, cancellation, burst queue, bounded timeout recovery and descriptor conversion.
A Brave regression check on 2026-11-10 delayed a real 64 KiB FIPS reply by 12 seconds:
the old reader reproduced `TimeoutError: signal timed out`; the corrected reader
rendered 18/18 tiles (44 verified blobs) with zero errors and no HTTP map requests.
Real FIPS transport requires a separately running
provider and a browser visit to the preview. There is no preview permission domain
in the published artifact: opening it in an unmodified production Soyli shell does
not grant this private bridge. The experiment deliberately keeps transport in the
parent page and leaves Soyli's iframe CSP and production protocol unchanged.

Dependencies are pinned to the upstream release artifacts in `package-lock.json`.
The local `.npmrc` preserves the lockfile's legacy peer-resolution mode and disables
install scripts; this experiment uses the TCP/FIPS and WebSocket entrypoints only.
