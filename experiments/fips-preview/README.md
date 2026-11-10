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
  "timeoutMs": 30000,
  "maxConcurrentTransfers": 2
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
bridge verify SHA-256. Two unique reads run at once by default; bursts queue within the 32 accepted
child-request limit. `maxConcurrentTransfers` accepts 1–8. Two is the conservative
setting for relayed links: eight competing streams can each miss their deadline
on a constrained connection even when the provider is healthy.
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
`requestTimeoutMs = ceil(32 / maxConcurrentTransfers) * (2 * timeoutMs + 750) + 10000`.
Each wave allows one additional transport read after a 750 ms pause, plus ten
seconds of grace. At the default concurrency of two and 30-second transport
budget, this is **982 seconds** for a completely full queue in which every read
needs its full retry budget; at concurrency eight it is 253 seconds. This
is a worst-case queue deadline, not a delay before reporting success. The child bridge uses this total deadline; the Hashtree reader's outer
deadline must exceed it. Applying the ordinary HTTP reader's ten-second deadline
would cancel queued FIPS reads before their transport budget expires. Only known
transient TCP/FIPS connect/read/write timeouts are retried; missing blobs and
invalid bytes remain errors. Cancellation
suppresses the reply; an already shared transport read may still finish and cache
its verified result. This is a caller-side deadline: underlying serialized FIPS work can outlast its nominal transport budget.

Failed transport attempts abort their individual TCP stream before retrying.
A graceful close after a failed read leaves unread data and the remote sender
alive, competing with subsequent requests. Valid complete responses still close
gracefully. The preview uses a small, pinned [vendored client transport](vendor/hashtree-fips-transport/README.md)
for this correction; the provider protocol, Hashtree hashes and verification are
unchanged. Retry in the napplet reloads missing tiles in place, preserving camera
and verified caches. Other tiles can continue loading while a partial failure is
shown.

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

The zoom regression uses a real provider through the WSS seeds in Brave. The
2026-11-10 check completed Rotterdam at z13.4 with 99/99 tiles and 143 verified
blobs. An injected child-read timeout at z14.4 was visible, and **Retry map
loading** recovered to 97/97 tiles without changing the camera or replacing the
reader. The complete run received 197 verified blobs (10.54 MiB), with no browser
errors and no HTTP map/blob requests. This demonstrates recovery, not low latency:
the live run still took several minutes on this relay path.

A controlled two-node FIPS/TCP carrier test with 20 ms link latency, 512 KiB/s
bandwidth and a four-second transport budget compared sixteen 256 KiB reads:
eight simultaneous reads completed 0/16; two completed 16/16. Separate regression
tests force repeated read timeouts and check that aborting failed streams releases
both client and provider buffers before a later verified read. The provider uses
the unchanged upstream transport in that test. These reproduce a congestion and
cleanup failure mode; they do not establish the exact cause of every intermittent
live timeout.

`soyli run verify` passes the consumer's guidance, recovery, type and build checks.
The preview remains deliberately non-conformant with the production shell: its
private bridge envelope and static-bundle `fetch` usage fail the corresponding
Soyli conformance checks. Production shell support is separate work.

Real FIPS transport requires a separately running
provider and a browser visit to the preview. There is no preview permission domain
in the published artifact: opening it in an unmodified production Soyli shell does
not grant this private bridge. The experiment deliberately keeps transport in the
parent page and leaves Soyli's iframe CSP and production protocol unchanged.

Dependencies are pinned to the upstream release artifacts in `package-lock.json`.
The local `.npmrc` preserves the lockfile's legacy peer-resolution mode and disables
install scripts; this experiment uses the TCP/FIPS and WebSocket entrypoints only.
