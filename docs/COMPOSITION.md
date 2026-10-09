# Composition demo

Open `/compose`, or select prepared maps in `/host` → **Your map library** → **Compose selected maps**. The optional source package remains listed but is not selected by default when prepared maps exist. **Go to map** focuses one source; **Fit selected** frames the union. Disjoint excerpts leave blank space between them.

Each card controls geometry layers and labels independently. Disabled sources are disposed, aborting in-flight reads and dropping their GPU meshes. Toggle one back on to reuse validated blocks in the shared persistent cache. Arrow buttons raise display priority. Coverage outlines show original advertised polygons; the actual visible coverage may be smaller after priority resolution. These controls change the consumer's subscription, not the files hosted on disk.

**Copy view link** includes catalog URLs, selected sources, layer choices, order, appearance and camera. Recipients must be able to access those hosts; a localhost link remains local to its machine. Links resolve current catalog offers rather than pinning their snapshots forever.

## Public delivery

- `GET /catalog` exposes ready map manifests, sizes, range URLs and per-map operation API URLs. It permits cross-origin browser reads.
- `/maps/<id>.atlas` supports HTTP Range, strong ETags, conditional reads and CORS, including preflight for `If-Match`.
- **Add another host’s catalog** reads another HTTP(S) catalog directly in the browser. Catalog-relative URLs resolve against that host. Identical map IDs on different hosts remain distinct offers.
- No authentication, public deployment or Nostr publication is added. The local server retains its existing loopback binding. Prepared files were already exposed through these routes; the new view makes their composition usable.

The catalog is a discovery hint. Before rendering, `AtlasReader` verifies package structure, block hashes and the snapshot advertised by the offer. Each reader retains its own snapshot identity, ETag and range source. GPU tile keys are namespaced by source session, so identical `tile/water/z/x/y` keys from different files cannot collide.

## Display ownership

The first enabled source owns each selected layer inside its polygon. A higher source offering only water and buildings does not hide roads, land or railways from a lower source. Labels use their own coverage channel. Disabling a channel releases that coverage to the next source. A source below its minimum zoom claims nothing; beyond its maximum stored zoom it overzooms through view zoom 20.

`composition-plan.ts` subtracts higher-priority polygons per channel in normalized Mercator coordinates, retaining holes and disconnected pieces. `CoveredTiles` skips payloads for cells entirely outside the resulting coverage. Partial cells remain whole immutable blocks. The Rust renderer uses stencil masks to clip those cells precisely, drawing layers from all sources in the normal global layer order. There is one WebGL context and one camera. Label boxes must fit within their owning coverage; placement shares a collision list across sources.

An empty authoritative tile is empty coverage, not permission to mix in a lower source. A transport failure is reported on the source card; this slice does not automatically fail over to a different dataset. Existing per-source zoom transition fallbacks remain active during tile loading.

## Scope and budgets

This is a **2D display composition**, including camera rotation/tilt of the ground plane. Building extrusion across clipped boundaries, cross-source feature picking, and a merged offline export are not implemented. Each source's **Open tools** link retains its own routing, search, isochrone and extraction capabilities. No search index or routing graph is fetched by this display reader.

Independent snapshots can compose visually without sharing graph identities. Cross-package routing still requires compatible partitions of one compiled graph and a frontier resolver; sharing an OSM date alone is insufficient. HTTP catalogs are the current discovery adapter. Nostr announcements, hashtree mirrors and ContextVM federation remain separate work.

Up to eight active sources are allowed in this UI. Per-source cache targets are 12 MiB GPU meshes, 8 MiB decoded geometry, 2 MiB decoded labels, 2 MiB parsed label data and 2 MiB directory descriptors. Active meshes can exceed the cache target while pinned. Persistent compressed blocks share the existing 128 MiB cache. Other allocations, directory roots, in-flight reads, places and GPU overhead are additional. The composition honors the existing cross-tab cache-purge signal, releases readers and pauses until reloaded.

Legacy combined-layer archives need regeneration/splitting before this demo can compose them. Polygon excerpts follow the existing non-antimeridian preparation constraints.

## Verification

- Bun tests cover priority by channel, polygon holes, triangular coverage, disabled/below-minimum sources, overzoom, hidden tile filtering, identical keys in different snapshots and catalog URL validation.
- Native Rust tests verify triangulated masks preserve holes, separate polygons and small-coordinate precision.
- Visible browser checks used the actual overlapping Vienna excerpts, then Monaco. A temporary second loopback host served a real Atlas file with cross-origin catalog/range access. Checks covered subscription removal across zoom changes, priority, shared-link reload, styles, the original viewer, host-library selection and a 390 px layout.
- The observed Vienna centre plus surrounding water/buildings view read approximately 2.8 MiB at z14.2 including labels in a fresh browser. This is an observation for that viewport, not a global bandwidth guarantee.
