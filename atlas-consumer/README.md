# Atlas FIPS consumer napplet

A map-first consumer of hosted Atlas files. The demo discovers signed map offers from a configured Nostr publisher, lets you compose selected maps, and reads their Hashtree blocks through the integrated Atlas FIPS provider. No HTTP map fallback is configured.

The napplet renders on this device. Its trusted Soyli preview parent owns relay discovery, FIPS connections and verification; the opaque iframe remains network-disabled. This is the explicitly experimental preview bridge, not yet a production napplet.soy networking capability.

See [the installed Soyli authoring guidance](docs/napplet-space.md) for the project toolchain and sandbox conventions.

## Run locally

From the repository root, with the existing root and napplet dependencies installed:

```sh
cd atlas-consumer
soyli run verify
cd ..
# Copy and edit the example: publisher + relay URLs + optional initial map IDs.
cp experiments/fips-preview/config.example.json experiments/fips-preview/config.local.json
bun experiments/fips-preview/preview.ts experiments/fips-preview/config.local.json atlas-consumer
```

Open the printed Soyli preview URL (normally `http://127.0.0.1:4188`). The sibling `napplet-space` checkout supplies the host; override its path with `ATLAS_SOYLI_SOURCE`. Configuration contains only public discovery hints. Never put a private key in it.

The **Maps** panel shows the discovered library. Select maps to combine them, choose the geometry layers you need, and opt into labels or imagery. The initial vector view reads geometry and the directory metadata needed to find it. Routing, search, feature extraction and analysis data are not loaded. Choosing a map does not download its entire archive.

The transfer panel shows verified FIPS payload bytes, cached reads and active work. These are application payload totals, not encrypted wire overhead. Refresh discovery checks announcements again; retry resumes missing reads without discarding the camera or verified caches.

## Authority and data flow

```text
Configured publisher + relays
  → trusted preview parent verifies signed offers and revisions
  → napplet receives catalog, chooses maps/layers
  → Atlas reader asks for ranges in an immutable file
  → Hashtree maps ranges to hashes
  → parent reads authorized descendants through FIPS and verifies bytes
  → opaque napplet decodes and renders locally with embedded WASM
```

Signed announcements supply roots, capabilities and provider/seed hints. The parent permits only currently accepted roots and their verified Merkle descendants. Withdrawn offers cease to authorize reads, including cached responses. The same parent exposes root-pinned map-operation RPC for future extensions; this display demo does not preload or invoke routing/search tools.

`atlas-preview.*` is a private experimental postMessage bridge, **not a standardized NAP or an available production Soyli capability**. It accepts only the current opaque preview iframe. Replacing the iframe cancels its requests. Page teardown closes discovery subscriptions and FIPS connections. Optional NAP-CONFIG settings retain usable defaults when absent; no signer or user account is required for these public maps.

The reused Atlas libraries still contain dormant HTTP reader code. This instance uses only the custom FIPS callback, and the iframe's `connect-src 'none'` remains enforced. A production shell adapter and an authority-free library entry point remain necessary before production conformance or publication. No production NAP requirement is invented to conceal that gap.

## Visual brief

A live cartographic instrument: the map fills the frame, a compact map picker controls the composition, and the transfer card makes selective delivery visible. Warm paper, pale blue water and quiet blue controls keep the existing Atlas identity. Colors belong to the app and remain stable under host theme changes. Large frames leave room around the controls; small frames use collapsible, scrollable panels. The minimum supported frame is 260 × 220; smaller frames show a resize notice. Empty, discovering, working and retry states explain what is happening.

## Verification

```sh
cd atlas-consumer
soyli run verify
soyli run test:conformance
cd ..
bun test experiments/fips-preview/consumer-session.test.ts experiments/fips-preview/consumer-bridge.test.ts
```

The focused tests cover signed offer lifecycle, root-scoped byte access, withdrawal, cancellation and UI composition/recovery. `verify` includes guidance checks, TypeScript and the single-file build. Browser checks use the real Soyli opaque iframe, including small and large frame sizes.

The upstream conformance check is intentionally not suppressed. The private bridge is not a standard NAP, and the static scanner can see dormant `fetch` branches in reused Atlas libraries. These are prototype limitations, not production conformance. See [the experiment](../experiments/fips-preview/README.md) for transport configuration and verification evidence.
