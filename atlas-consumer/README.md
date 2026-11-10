# Atlas FIPS consumer napplet

A map-first napplet scaffolded with `soyli new atlas-consumer`, using Atlas's existing WASM renderer and Hashtree reader. The demo reads real hosted Atlas bytes through a FIPS node in the patched Soyli preview parent. No HTTP map fallback is configured.

See [docs/napplet-space.md](docs/napplet-space.md) for generated authoring guidance and [the preview experiment](../experiments/fips-preview/README.md) for the real transport and launch commands.

```sh
soyli setup
soyli build
# From the repository root, after configuring the sidecar and public descriptor:
bun experiments/fips-preview/preview.ts /path/to/public-preview-config.json atlas-consumer
```

Open the printed preview URL. Pan and zoom, and expand **Follow the bytes** to inspect the pinned root, provider identity, verified payload bytes and cache reuse. The archive stays on the server; only relevant Hashtree blocks are transferred. The displayed byte count is verified blob payload, not FIPS/WebSocket wire overhead.

## Explicit prototype boundary

`atlas-preview.*` is a private experimental postMessage bridge, **not a standardized NAP or an available production Soyli capability**. The napplet talks only to its parent; the parent pins one provider, owns networking, validates hash replies and transfers bytes to the opaque sandbox. WASM is embedded in the single-file artifact. Model APIs, routing, persistent cache and public app publication are outside this first proof.

The reused Atlas libraries still contain dormant HTTP reader code; this instance uses only the custom FIPS blob callback, and the Soyli sandbox's `connect-src 'none'` remains enforced. A production shell adapter and a clean browser-authority-free library entry point are follow-up work before claiming production conformance.

## Visual brief

A live cartographic instrument: the map fills the frame, a small connection card names the dataset, and a compact evidence card makes selective FIPS transfer visible. Warm paper, pale blue water and quiet blue controls; map colors stay app-owned regardless of shell theme. Large frames give space to the map; narrow frames compact the HUD; tiny frames keep the map and byte totals usable.

## Verification

`soyli run verify` passes the scaffold guidance checks, TypeScript and the single-file
build. Type checking keeps strict types; unused-symbol lint is disabled to match
Atlas's reused library sources. The root's Hashtree tests cover custom transport
verification and prove that a failed custom read cannot fall back to HTTP.

`soyli run test:conformance` currently reports two expected prototype limitations:
its static scan sees dormant `fetch(...)` branches in the reused HTTP reader and
WASM loader, and the private `atlas-preview.*` envelope is not a standard NAP.
These checks are not suppressed. The live preview keeps the sandbox's no-network
CSP, embeds WASM bytes, and passes map reads exclusively through the FIPS callback.
Do not publish this artifact as production-conformant yet.

The live browser proof blocked `/maps/` and `/hashtree/` HTTP requests. Rendering
and zoom reached 25 tiles / 185,489 triangles using 3,691,309 FIPS payload bytes in
71 verified blobs, with zero HTTP map requests and zero browser errors. This is
selective access to a 16,631,274,453-byte archive, not a full archive download.
These are observed sample figures, not throughput guarantees.

Responsive checks passed at 200×160, 320×560, 900×600 and 2400×1200, including
pan/zoom, with no horizontal overflow or runtime errors. A second cold run took
50.7 seconds to settle the initial map over the public seeds. This first proof is
not a performance claim: persistent caching, concurrent range traversal and
transport tuning are follow-up work.

## Slow mesh transfers

The reader uses the preview's advertised queue-and-transfer deadline rather than
the HTTP reader's ten-second default. The connection card shows directory progress;
transfer details include active, queued, retried and cancelled work. A known
transient TCP/FIPS timeout gets one automatic reattempt, retaining verified cached
blobs. Hash failures and authenticated missing blobs are never retried as timeouts.
