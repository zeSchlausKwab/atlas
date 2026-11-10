# Atlas FIPS consumer napplet

A map-first reader for immutable Atlas files. It discovers signed offers through
standard NAP-OUTBOX, composes selected maps, and selectively reads verified
Hashtree blocks through the shell's **experimental `soy.fips/1` resource profile**.
It uses ordinary soyLI preview and the shared napplet.soy Player runtime. The
`atlas-preview.*` launcher is no longer part of the normal workflow.

This companion change targets the shell branch `codex/fips-resource-integration`.
It is not deployed, released or a claim of interoperability with other shells.
An older shell shows a missing-profile explanation. No login is needed for public
map reads; the shell asks before connecting to the requested roots/providers.

See [soyLI authoring guidance](docs/napplet-space.md) for toolchain and skill conventions.

## Run locally

Use the development soyLI checkout containing that profile, with Atlas's existing
workspace dependencies and renderer WASM built. From this directory:

```sh
pnpm verify
pnpm test:conformance
soyli dev --project .
```

For an uninstalled CLI, from the companion shell checkout:

```sh
bun apps/cli/src/index.ts dev --project /path/to/atlas/atlas-consumer --no-open
```

The normal soyLI command starts the project's configured Vite build watcher and
serves its built artifact. There is no custom launcher or injected script. Do not
run the historical `experiments/fips-preview/preview.ts` for this workflow.

## Prepare publication source

This directory imports shared Atlas packages and the renderer in its parent
repository. Publishing it directly would not produce a standalone, rebuildable
project. soyLI also publishes reachable Git history, so the private Atlas
repository must not be passed directly to publication.

From the Atlas root, export a reviewed commit into a new private directory:

```sh
bun scripts/prepare-consumer-release.ts /path/to/private/atlas-release COMMIT
cd /path/to/private/atlas-release
bun run setup
bun run verify
```

The exporter preserves the committed consumer under `app/`, its transitive
TypeScript dependencies under `packages/`, and the renderer/routing Rust source.
It includes the reviewed generated WASM and bindings with hashes, both dependency
lockfiles, build wrappers, source provenance and an explicit file inventory. It
excludes the host, administration, map compiler, private configuration and Git
history. Output must be empty; the source checkout is never rewritten.

The owner approved publication of the **consumer-only export under MIT** on
10 November 2026. The exporter supplies that license and preserves upstream
notices. This grant applies to the exported consumer and its required source;
it does not change the private Atlas repository or license the excluded server,
compiler, administration or deployment code. Review `SOURCE-INVENTORY.json`
before each publication, especially after dependency changes. Initialize and
commit a separate publication repository, capture a loaded map, and use ordinary
`soyli check`/`soyli publish`.

Exported builds use a documented custom command recipe. A fresh source archive
needs `bun run setup` before `soyli build`; a browser or hosted Studio builder
needs the corresponding Atlas toolchain profile. No such hosted profile is
claimed by this change. Compatible shell/soyLI support must ship first.

Shell settings expose **Trusted map publisher** (hex public key), **Discovery relay
hints**, and optional **Preferred map IDs** through NAP-CONFIG. Restart the napplet
to apply changes. Empty preferred IDs follows an available signed default view.
These are public hints, never private keys. Relay routing/approval and FIPS
connection policy belong to the shell; offer schemas and publisher trust belong
to Atlas. The Maps panel shows publisher, relay and selected provider/root details.

Choose multiple maps, adjust geometry layers and opt into labels or imagery.
Geometry plus essential directory/manifest metadata loads initially. A signed
visual recipe does not authorize extra data families. Routing, search and analysis
blocks are not startup dependencies; selecting a map never downloads its archive.

## Boundary and lifecycle

```text
NAP-CONFIG publisher/relay hints
  → NAP-OUTBOX public discovery
  → Atlas signature, revision, expiry, withdrawal and default-view validation
  → selected roots/providers approved through resource.soyFips
  → Atlas range reader traverses Hashtree File nodes
  → shell authenticates FIPS peers, verifies hashes, lengths and Merkle ancestry
  → transferable bytes reach the opaque iframe
  → embedded WASM decodes and renders locally
```

The network-free `HashtreeReader` accepts a byte reader. `RemoteSource` is separated
from `HttpSource`; the consumer imports neither HTTP delivery nor relay/FIPS
implementations. The iframe retains `sandbox="allow-scripts"` and
`connect-src 'none'`. No direct fetch, WebSocket, EventSource or dormant HTTP
fallback is bundled. The offline/local Atlas demo remains separate and usable.

`src/vendor/fips-resource-client.ts` is a verbatim, network-free SDK adapter from
`soytec/napplet-soy`'s `packages/resource-client/src/index.ts` (profile `soy.fips/1`).
It is copied while the package/profile is experimental, with provenance recorded
in `src/vendor/README.md`; keep both copies synchronized. Do not list `fips` or
`mesh` as a standard manifest domain. `resource` and `outbox` are required; missing
experimental support remains a visible unavailable state.

The shell owns ephemeral transport identities, keys, connection consent and
frame-scoped grants. Atlas never receives a signer or relay pool. Each grant binds
a root, sizes, expiry and providers; only proven descendants are readable. Atlas
withdrawal or revision changes abort reads and release obsolete grants, including
cached access. Account changes and frame replacement retire the shell scope.
Revocation cannot recall bytes already delivered to the app.

The transfer panel distinguishes verified payload bytes, cache reuse, active and
queued work, retries and errors. Payload totals exclude encrypted wire overhead.
Retry resumes missing data while preserving the viewport and completed tiles.
The shared shell limits two active transfers globally, 128 pending calls and
32 MiB verified cache per frame. Public relay paths can still be slow.

The separate root-pinned `request()` API implements Atlas RPC v1, not CVM/MCP. It
preserves status, headers, snapshot identity and binary bodies, requires separate
permission and never automatically replays an uncertain operation. The display
UI does not start routing/search tools. The shell allowlist is GET `capabilities`
and POST `route`, `isochrone`, `search`, `reverse`, `peak`, `features`, `offline`,
optionally under `members/mN/`; other server registry/admin endpoints are absent.

## Checks and evidence

```sh
pnpm verify                         # guidance, recovery, resource lifecycle, TS, build
pnpm test:conformance                # upstream CLI on the actual single-file bundle
cd ..
bun test tests/hashtree.test.ts tests/hashtree-fips-contract.test.ts \
  tests/fips-runtime.test.ts tests/composition.test.ts
```

The companion shell's `docs/FIPS-RESOURCES.md` records exact upstream/package pins,
commands, live-browser evidence and rollout gates. Consumer tests cover signature
and publisher validation, revisions/deletions in either relay order, expiry,
signed two-map views, independent providers, no eager reads, batched root consent,
withdrawal cancellation, late approval disposal and missing-profile behavior.
Composition regressions cover geometry defaults, explicit labels/imagery, overlap,
user choices overriding defaults, partial failures and retry preservation.

The upstream conformance CLI currently reports **5 passed, 0 failed, 5 skipped**:
manifest-event/index/requires, observed wire envelopes and clean teardown remain
unmeasured by that harness. They must not be reported as passed. The companion
real opaque-frame tests exercise the matching shim/host wire, account/frame
revocation and teardown separately. Physical mobile-device testing and independent
shell interoperability are not established.

## Visual brief

A live cartographic instrument: a frame-filling map, compact map picker and
transparent transfer diagnostics. Atlas keeps its own warm-paper/map palette.
Small frames use collapsible panels and larger touch controls; below 260 × 220
there is a resize notice. Choosing a visual style never grants data access.
