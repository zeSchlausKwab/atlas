# Atlas demo development on the HM90S

Decision: retain OSM PBF as the canonical input. Demonstrate regional hosting and
composition on the LAN server before attempting a continent/planet compiler.
Overture remains a possible future adapter, not a prerequisite or a substitute
for the current OSM semantics.

## Available machine and operating budget

Observed over SSH on 2026-10-10: x86_64 NixOS 26.05, 30 GiB RAM, about 28 GiB
available, 403 GiB free on the root filesystem, no swap. The existing llama-cpp
service uses about 3.3 GiB and can use eight CPU threads. It stays independent.
Map rendering stays on the browser/device GPU; this server handles files,
compilation and optional CPU queries/routing. No discrete server GPU is required.

Initial limits: one preparation at a time; four Cargo build jobs; build scopes
limited to four CPU equivalents and 16 GiB RAM; serving/preparation service capped
at six CPU equivalents and 20 GiB, with memory pressure beginning at 16 GiB.
These are protective defaults, not measured Atlas capacity guarantees. Monitor
the entire service cgroup, not only the parent Bun process. An OOM kill is a
failed job, never successful partial coverage.

Keep at least 60 GiB free as a proposed operational reserve. Track source cache,
temporary workspace, final packages and Nix/Cargo caches separately. The current
preparation estimate is approximate and does not enforce that reserve yet. Do not
infer planet output size from compressed PBF size or the four regional files.

## 1. Repeatable remote release and existing demos

Ship current source, portable WASM and optionally the prepared Vienna/Danube
packages. Build native Rust import tools on Linux. Keep prepared maps, source
downloads, host policy and secrets outside code releases. Use the normal viewer,
host console and HTTP catalog; no new rendering frontend.

Proof:
- Fresh server release passes UI/WASM, catalog, byte-range and tool prerequisite checks.
- A second code-only release preserves map files and host library identities.
- Previous code can be restored; a failing candidate leaves the live release intact.
- The Mac consumes server-hosted bytes through a localhost SSH tunnel; local files
  are not accidentally supplying the demonstration.
- Map preparation cannot be interrupted by a normal deploy.

Delivery: `scripts/deploy.ts`, a Nix runtime, a systemd user service and
`docs/DEPLOYMENT.md`. HTTPS and authentication for direct LAN browser use are a
follow-up: an ordinary LAN HTTP origin lacks secure-context browser capabilities.

## 2. Capability selection and client/server parity on real network reads

Use the existing four compatible packages (about 4.77 GiB total, plus the base map).
Prove buildings+water-only viewing without routing/search payloads. Repeat search,
nearest street, peak query, feature extraction, route and isochrone operations on
the client and on a single server package with matching inputs.

Measure cold and warm transferred bytes, request count, time to first complete
view, frame times, worker latency, browser memory and server cgroup peak memory.
Use fixed viewports/trips and immutable snapshots. Include driving, cycling and
walking, coverage edges, disconnected routes and cancelled requests. Compare
rendering with MapLibre/PMTiles using equivalent area/detail; different source
contents are not a performance benchmark.

Proof: expected capability blocks only, result parity within documented snapping
and numeric tolerances, no extra network reads on a cached replay, and controls
remain responsive during computation. Record baselines before setting targets.

## 3. Two real hosts and a coherent composition

Serve compatible portions of the shared compiled graph from the Mac and HM90S.
Use the normal client composer, catalog discovery and per-source priority. Then
switch off one host, show the exact missing coverage, and replay a cached route.
Do not reconstruct connections by matching nearby coordinates.

Proof: cross-host routes use both hosts; repeated graph cells have identical
hashes; gaps and incompatible graph identities are explicit. Search/extraction
remain scoped to a selected package until a merge contract exists. Cross-package
server routing is separate work; it is not implied by single-package server parity.

## 4. Build a compiler with bounded working memory

Replace the full in-memory node map and monolithic intermediate JSON with a
disk-backed OSM coordinate/reference index and streamed feature records. Compile
spatial partitions and tile/index blocks incrementally. Push capability selection
before expensive work while retaining required nodes, relation members and turn
restrictions. Enumerate occupied tiles, not every tile in a huge bounding box.

Preserve shared graph cell identity across regional outputs, complete relation
geometry at boundaries, and retain source checksums/build recipes. Add resumable
stages, transactional finalization, progress, disk reserve enforcement and peak
resource accounting. Serving should eventually be independent of the build worker
lifecycle; the current deploy guard is an interim measure.

Proof: small fixtures match existing geometry, holes, building heights, labels,
search and transport semantics. Scaling Austria -> DACH/selected countries keeps
RAM within the configured bound. Interrupt/restart resumes without corrupting
published packages. Measure retained disk at each stage, including graph creation.

## 5. Europe presets, then decide on planet

Host console scope: Europe, selected region/polygon, and eventually planet.
Editable presets: overview, water+boundaries, buildings+water, display-only,
regional explorer and navigation. Display layers and semantic capabilities remain
independent; disabling drawn roads need not disable a requested routing graph.

Europe's current PBF is about 35 GB; planet is about 95 GB. Recheck pinned release
sizes at preparation time. A source file fitting on disk does not establish that
the output plus temporary indexes fit. Start with low-detail/selective Europe,
measure, then expand. The host UI must identify source-download bytes separately
from estimated output and peak workspace. Record missing source support honestly:
administrative boundaries need an importer; OSM PBF does not include raster
elevation; global land/ocean assembly and antimeridian handling need dedicated work.

Proof: recipes persist and reproduce supported contents; excluded capabilities
are absent from the package and catalog; interrupted download/build can resume;
published output passes all block hashes and coverage checks. Approve a planet
recipe only after measured disk/RAM estimates fit the remaining capacity. A
planet overview and a planet with z0-16 details and all routing are separate targets.

## 6. Discovery and extensible operations

Reuse the operation registry for HTTP and ContextVM tools. Add multi-map dispatch
and identity/capability descriptions, then signed Nostr offers pointing to package
manifests. Hashtree can supply verified blocks/mirrors. Keep discovery independent
of byte transport and query execution. Public announcements require a deliberate
publishing action; deployment alone never publishes them.

Proof: one consumer discovers both hosts, requests only supported operations and
can obtain an identical block from a mirror. A custom operation declares its input,
output, meaning, data requirements and budget. Cross-snapshot identity, updates,
payments, public hosting and general planet routing acceleration are later slices.

## Development loop

Develop and run focused tests on the Mac. Commit completed slices. Deploy the
working tree to a new server release and verify its reported release ID. Exercise
the normal UI via `bun run deploy tunnel`. Store measured results with the input
recipe and snapshot; keep generated maps and large logs out of Git. Use the server
for larger PBF preparation, not as the only copy of source code. NixOS firewall,
boot behavior and TLS changes are separate from routine application releases.
