# Soyli and napplet.soy: replace the Atlas FIPS preview patch

Implementation prompt, updated 10 November 2026 against Atlas commit `8ff058a`.

## Objective

Work in `/Users/schlaus/workspace/napplet-space`. Implement shared shell support so the Atlas consumer runs in ordinary Soyli preview and napplet.soy playback without Atlas's injected preview script. It must discover signed map offers, compose selected maps, and selectively read verified Hashtree data over FIPS. The Atlas map host must not need public HTTP delivery or its own DNS name. Relays and bootstrap seeds may still use DNS.

Use `/Users/schlaus/workspace/geo-format` as the working reference and migrate its consumer to the supported interface as a companion change. Read each repository's AGENTS.md. Preserve unrelated work. Do not restart the Atlas server, change its configuration, publish announcements, or interrupt active map builds for this task. Live verification should only read published data; use isolated fixtures for mutations.

## What already works

Atlas's integrated provider serves multiple immutable roots, signed Nostr map announcements and default-view recipes, selective Hashtree blobs, and root-pinned operation RPC. HTTP delivery is optional and currently disabled on the demo host.

The demo napplet now discovers the configured publisher's library, selects multiple maps, changes geometry layers, and optionally reads labels or imagery. Its default reads geometry plus necessary directory/manifest metadata. It does not preload routing, search or analysis. Verified live: six signed offers, two composed Lower Rhine maps, 27/27 tiles, no browser errors and no HTTP map requests. Cold rendering took minutes through the public relay path, so performance remains something to measure.

The temporary trusted parent owns discovery, transport and verification. The opaque iframe is network-disabled. This patch is deliberately not production conformance: the private `atlas-preview.*` wire envelope and dormant `fetch` references in reused libraries still fail two conformance checks. Fix those boundaries rather than suppressing the checks.

Read these Atlas files before designing a replacement:

- `experiments/fips-preview/consumer-protocol.ts`
- `experiments/fips-preview/consumer-session.ts` and its tests
- `experiments/fips-preview/consumer-bridge.ts` and its tests
- `experiments/fips-preview/preview.ts`
- `atlas-consumer/src/bridge.ts`, `composition.ts`, `main.ts`
- `packages/hashtree/src/discovery.ts`, `source.ts`, `published-map.ts`
- `packages/fips/src/client.ts`, `rpc.ts`, `server.ts`
- `docs/FIPS-HOSTING.md` and both consumer/experiment READMEs

## Protocol decision first

Read Soyli's `docs/PROTOCOL.md` and `docs/NAP-REVIEW.md`; verify current upstream contracts and record exact compatible pins. This checkout currently pins shim 0.31.0 and core/nap 0.33.0. Do not assume versions mentioned in review notes are installed. Also compare RESOURCE proposal semantics with the installed SDK: this host currently uses Blob replies and `requests` batches. Do not mix those with a differently pinned base64/`urls` contract or patch `node_modules`.

NAP-MESH PR 122 is not the missing byte transport. As checked on 10 November, it is an open draft at `bf9a4722244e29661c06d2fb4db7d3c7346d064a`, describing publish/subscribe within a user's paired circle; `blobs` returns availability counts, not blob bodies. It does not specify public FIPS provider connections or Atlas RPC. Recheck it before implementation: https://github.com/napplet/naps/pull/122

Map the requirements onto existing APIs before introducing anything:

- Use OUTBOX for ordinary signed-event discovery; RELAY is the explicit-relay escape hatch under existing policy. Map kinds, offers and default-view semantics belong to Atlas, not a special case in the generic shell.
- Evaluate a content-addressed RESOURCE transport adapter for Hashtree/FIPS bytes. Current RESOURCE schemes are data/HTTPS/Blossom; do not pretend htree/FIPS identifiers are already standardized. Document how an accepted immutable root and validated provider hints authorize reads.
- Atlas RPC is a separate application protocol, not ContextVM/MCP. Do not relabel it as `cvm.request`. Reuse an existing suitable service contract if it actually fits; otherwise prepare the narrow protocol proposal/extension required.
- Do not invent an apparently standard NAP name, wire envelope or manifest requirement. If an upstream gap remains, isolate an explicitly experimental compatibility profile, implement the independent standards-compatible work, and report the remaining standardization boundary accurately.

Write a short contract mapping and then implement. The result should not be another Atlas-only preview injection.

## Shared implementation

Start at `packages/runtime/src/host.ts`, `capabilities.ts`, `prelude.ts`, and `index.ts`. Both `apps/cli/src/preview/client.ts` and `apps/web/src/components/player.tsx` attach this shared host. Preview bundling lives in `apps/cli/src/preview/{bundle,assets,server}.ts`.

Build one reusable transport/resource service used by both entry points. Keep Atlas offer parsing, file layout, renderer, composition and layer-selection semantics in the Atlas consumer/shared Atlas package. Any new SDK/shim binding must agree with the selected contract; do not add a host handler that ordinary napplets cannot call through the SDK.

Required behavior:

1. Public map reads work without a signer/login. Provider identity comes from validated public configuration and signed announcements; no hardcoded Atlas publisher privileges. Allow the user to configure discovery hints and see which sources are trusted. Apply the same policy to other publishers.
2. Verify signatures, revisions, expiry, withdrawals and cross-relay deletion ordering. Respect signed default compositions while keeping client overrides and geometry-only defaults. Do not confuse a proposed visual style with permission to fetch additional data families.
3. Resolve requested file ranges through verified Hashtree blocks, never the entire archive. Verify SHA-256, lengths and Merkle relationships. Preserve authority isolation: arbitrary hashes or provider addresses must not gain authority merely because a napplet supplied an accepted root.
4. Cache immutable verified content, deduplicate concurrent reads, and use transferable binary buffers. Bound queues, in-flight bytes and memory; show pressure and retry states. Existing RESOURCE defaults (60 calls/minute, 16 pending, WorkQueue 4/16, 128 MiB/frame, 10 MiB/blob) need measurement and an appropriate resource profile for tile traffic. Do not simply make all shell networking unlimited.
5. Cancellation, iframe replacement, reload, disposal and account changes must retire old requests/subscriptions and prevent stale replies. Test cold and cached reads, interrupted streams, reconnects, provider failover and overlapping requests. Retry immutable reads with backoff; preserve the viewport and completed tiles.
6. Root-pinned server operations use explicit operation permissions and preserve status, schema, snapshot information and binary results. Keep provider/session affinity where needed. Never replay a possibly completed/stateful RPC on another provider after a lost response. Do not expose host administration. The current preview allowlist is narrower than Atlas's full server registry; document that distinction.
7. Keep the napplet opaque, without direct fetch/WebSocket/EventSource, host DOM access, relay pools or keys. Provide an Atlas consumer bundle entry point without dormant direct-network implementations, so static conformance checks pass for the correct reason.
8. Expose useful diagnostics: discovery state, verified payload bytes, cache reuse, active/queued reads, retries and actionable failure causes. Distinguish payload bytes from wire overhead. The shell owns connection settings; app-specific controls stay in the napplet.

FIPS is the default for this Atlas demo. No silent HTTP fallback. The shell may retain ordinary HTTP RESOURCE support for other apps, and Atlas's explicitly local/offline demo remains usable. Selecting a map must not load its routing/search/extraction data. Prepare the service API for those capabilities without adding their UI to this display demo.

## Acceptance and migration

Use the existing runtime, preview and browser test harnesses, especially
`packages/runtime/src/{host,host-services,runtime,work-queue,outbox-host}.test.ts`,
`packages/client/src/transport.test.ts`,
`packages/nostr/src/{playback,playback-routing}.test.ts`,
`tests/services/cli-preview.test.ts`, and
`tests/browser/{runtime,linked-assets,cli}.spec.ts`. Port the relevant Atlas
consumer-session, consumer-bridge and timeout-cleanup regressions. Cover:

- Ordinary `soyli dev` and the same production player path, without `experiments/fips-preview/preview.ts` or injected `atlas-preview.*` messages.
- Two signed maps, independently identified providers, overlapping coverage, layer selection, opt-in labels/imagery, signed default view, withdrawal/expiry and stale-revision handling.
- No HTTP map/catalog/blob fallback and no eager whole-file download. Verify which data blocks are read, not just whether the map appears.
- Warm-cache reopen, interrupted transfer recovery, cancellation and frame isolation. Cache hits cannot bypass authorization; revocation does not claim to recall bytes already delivered.
- Tampered blobs, unauthorized roots/providers, malformed requests and RPC response uncertainty.
- One root-pinned server operation outside the geometry-only startup path; verify its provider/snapshot identity and absence of automatic replay.
- A small non-Atlas fixture using the same public APIs, proving the implementation is reusable rather than publisher- or map-specific.
- No login needed for public reads; missing optional capabilities fail gracefully. If mesh delivery is essential, accurately declare the required supported capability rather than inventing an HTTP fallback.
- Real opaque-iframe conformance with manifest, wire and lifecycle evidence. Do not call skipped checks passed. Test Brave/Chromium, resizing and mobile controls; distinguish emulated frames from physical-device verification.

Migrate `atlas-consumer/src/bridge.ts` and its manifest/build imports. Keep composition/rendering logic unless the supported contract requires a change. Remove the temporary launcher from the normal workflow only after parity; retain a clearly marked historical fixture if useful. Update authoring guidance, configuration examples, protocol pins and test evidence. Follow the repository's Nix checks before pushing changes affecting shared packages, CLI, dependencies or bundled preview assets.

Commit coherent changes. Report implemented versus verified versus deployed/released separately, with exact commands and any protocol gaps. Do not deploy production or publish releases as a side effect of this handoff; prepare those steps for the next explicit rollout.

## Native Android experiment

The isolated [Android viewer](ANDROID-NATIVE-FIPS.md) now demonstrates real Atlas
reads over native TCP/UDP with a separate Rust provider. Its signed
`atlas-native-v1` catalog is explicitly experimental; it does not replace this
handoff’s production discovery, SDK or sandbox requirements. Its host-backed
sidecar can also read the deployed server's published Atlas files and Hashtree
indexes directly, using separate identities and physical TCP/UDP ports. That adapter does not add native ingress to the TypeScript process or
implement the shared shell/discovery contract above. No shell source changes
are implied by that demo.

### Npub routing addendum — 11 November 2026

Atlas commit `79ea2d2` adds a tested native three-node path: Android selects a
**map host npub**, joins a separately pinned entry peer over physical TCP or UDP,
then uses FIPS identity routing to reach the provider through that peer. The
provider has no publicly reachable listener in this deployment; its outbound
link to the entry is TCP on server loopback. The client never receives its IP.
Both carriers share one host identity. Public entry-peer profiles are bundled,
so launching the phone viewer needs no manual connection. Physical Pixel tests
cover maps, satellite imagery, layers, pan/pinch and lifecycle/network recovery.

Keep **identity selection** separate from **network bootstrap** in the shared
shell. An npub identifies the destination; a reachable entry point remains
necessary. Do not promise public Internet reachability from this LAN-only test,
or label a mixed UDP-entry/TCP-onward path as UDP on every hop. Show the selected
carrier, entry identity and authenticated target identity in diagnostics.

The native experiment requests a fresh, host-signed catalog from a well-known
service at that npub, then grants roots and verifies descendants. This removes
manual catalog hashes for this demo; it is not a replacement for production
announcement/withdrawal semantics. Its catalog signer is the native host's key.
The shared contract must still support distinct publisher and provider roles
with validated authorization between them. Do not transfer the demo's implicit
same-key assumption into general Nostr discovery. See the native architecture
for framing, expiry, trust boundaries and retained limitations.

### Public native entry addendum — 11 November 2026

The native provider now also joins a pinned public entry using physical UDP.
Signed catalog and real Atlas reads have been verified through that public route,
without HTTP/WebSocket fallback or a map-host DNS entry. See
[NATIVE-FIPS-HOSTING.md](NATIVE-FIPS-HOSTING.md) for public profiles, exact hops and
limits. Android 0.5.0 now bundles the public UDP entry and passed a separate
cellular test: Wi-Fi disabled, clean automatic launch, complete Lower Rhine East
viewport (18/18 tiles, 3,542,996 verified bytes). The cold load took about eight
minutes, so shell work must include transport performance and recovery rather
than assume LAN responsiveness. Shared Soyli/shell integration remains pending.
The public path depends on one verified external UDP entry; do not advertise
native TCP WAN access or high availability. Preserve host npub addressing and
separately pinned entry settings; never expose unrestricted page sockets.
