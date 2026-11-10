# OSM-authoritative routing federation

Decision: independently prepared Atlas maps must be routable together without a
common compiled Atlas parent. A canonical mother `.atlas` remains a supported
build optimization and fallback, not a prerequisite for publishing routing data.
OSM supplies object identity. Hashtree supplies immutable bytes and delivery.
Neither content hashes nor a shared calendar date alone establish connectivity.

## First executable contract

`transport.federation` identifies `openstreetmap`, one exact upstream PBF SHA-256,
`atlas-osm-transport-v1`, `osm-way-segment-v1`, and `completeBounds`. Independent
regional extractions retain the upstream revision while recording their own
input digest for checkpoints. They may have different extents, package hashes,
geometry, imagery and local graph indexes. No parent Atlas file is needed.

This first version is intentionally stricter than general federation: independent
regional Geofabrik PBFs with different upstream digests, mixed OSM epochs, custom
networks and different cost policies do not automatically connect. A replication
sequence/object-version contract and validated handovers across revisions are
future work. Do not label different-source routing as complete because OSM node
IDs happen to match. Signed publisher claims establish provenance, not proof of
real-world completeness or honest compilation; trusted publishers remain required.

RCL3 keeps the RTE2 graph payload and replaces each graph-local u32 segment ordinal
with a 16-byte little-endian identity `(positive OSM way ID << 32) | original
segment index`. The index is in the complete original way, before access/barrier
filtering. Upper unused bits must be zero; the way must agree with the segment.
Repeated node pairs in a way remain distinct. Local node indexes stay compact.
The complete-way index can change after an OSM edit; the source-revision contract
prevents treating it as a revision-independent physical-road identifier.

Node identity remains the OSM node ID. Coordinate proximity never creates an
intersection. Turns, direction flags and directional costs stay in the graph.
RCL1/RCL2 remain readable and retain their shared-compiled-graph restriction.
A composition never mixes those legacy ordinals with RCL3 identities.

## Coverage and handover

New regional and partitioned preparations from a pinned PBF use smart extraction with complete
ways and restriction relations. Only z14 cells strictly within the extraction
bounds can own routing nodes. The map selection/padding independently limits which
of those cells it actually retains. Outer partial cells remain data but cannot be
used to claim complete adjacency. Missing coordinates prevent federation metadata
from being published. Completing restriction relations is essential, not merely
copying roads in a geographic padding rectangle.

The client checks the authority and contract before routing. It selects eligible
complete cells, compares available overlapping cell hashes, then requests verified
payloads from an available provider/cache. Canonical native emission orders
segments by way and original index; node/turn order follows deterministically.
Any overlap mismatch is an error, never silently resolved by rendering priority.
The initial validator is conservative: semantically equivalent but differently
serialized cells may be rejected. Owner-node dependency fingerprints and boundary
summaries can later permit more flexible compilers without weakening validation.

Missing coverage/network/cache bytes yield missing-data and a resumable frontier.
A complete available provider may replace an unavailable mirror. The contract
relies on accurate source/coverage claims; comparing hashes cannot detect an
omitted road shared by every publisher. A segment with no nodes inside a regional
extract may also be absent from snapping coverage, even when it geometrically
crosses the region; owner-node adjacency and complete geometric intersection
coverage are different guarantees.

## Rollout and fallback

New builds with verified extraction provenance emit RCL3. Existing
RCL2 routing spools and completed routing stages resume unchanged. Existing maps
are not relabelled or automatically rebuilt. Upgrading an old map requires
rebuilding its routing section from retained PBF data; unrelated geometry,
search, imagery and custom blocks can be reused. The running Western Europe job
is not restarted by this change.

If independent-build checks reveal an unsolved compatibility issue, retain RCL2
mother-file composition while fixing the source contract. Do not remove validation
to make a demo connect. No centralized graph is required by the new file format.

## Acceptance evidence

The native/WASM integration test builds two *different PBF files* independently
from a common synthetic OSM authority, compiles a separate whole-area reference,
and checks walking/cycling/driving routes and isochrones over cell seams. It also
checks cross-seam turn restrictions, overlapping identities, cache-only replay,
missing coverage, conflicting data/revisions, and capability-preserving excerpts.
Run `bun run verify:routing-federation`; it builds the native compiler and routing
WASM before executing the tests. The full Bun suite also checks the legacy path.

A real Liechtenstein rehearsal independently extracted a north and south PBF and
compiled a third whole-area reference. Two independent publisher keys announced their maps over separate loopback
Nostr relays. Hashtree supplied 100 distinct routing cells in 170 blob requests;
direct Atlas range delivery was disabled (zero raw-file requests). Walking/cycling routes (18.0 km) and
driving (19.4 km) matched the reference costs, coordinates and OSM way sequences.
After both servers stopped, the cached driving route still completed. Run
`bun scripts/verify-routing-federation-real.ts` with `data/liechtenstein.osm.pbf`
present (or supply the path to that dataset). The synthetic suite also starts a fresh reader and engine from the persistent
cache after both hosts stop, and verifies missing-data/retry when a host is
unavailable. These are isolated local publication tests; they do not claim public
relay deployment.

Checkpoint recovery can be tested in either codec with `bun run verify:graph-resume`;
set `ATLAS_ROUTING_IDS=osm-way-segment-v1` for RCL3. Mode-specific spool and coordinate
files prevent a new build from overwriting a legacy checkpoint. The shared graph
fallback still emits exactly the same RCL2 bytes on the real fixture.

The extraction contract follows [Osmium's smart strategy](https://docs.osmcode.org/osmium/latest/osmium-extract.html)
with `types=restriction` (plus optional multipolygons/boundaries). Plain complete-way
extraction is insufficient for this claim. Bump the routing contract when changing
costs, access/barrier policy or restriction interpretation. Old checkpoints retain
the contract they were built with; a code update must never relabel them.

## Publishing and preparing independent maps

The client validates transport metadata in signed discovery offers, then checks
routing claims, scope, size and snapshot against the Hashtree-pinned archive before
using it. Composer shows the routing compatibility of the opened selected maps.
This confirms a common authority/contract; actual cell availability and overlap
agreement are still checked during routing, not inferred from bounding boxes.

`recipes/europe-three-map-demo.json` and `scripts/queue-europe-demo.ts` now create
three independent cached-PBF preparations. All retain the same verified upstream
planet revision, including the two smaller maps. They can be built on separate
hosts; a single host still schedules one compiler at a time. Their durable receipt
pins the recipe, source revision and server, and refuses legacy mother-map receipts.
Use `--only=rhine-alps,alps-danube` to queue the pair without the large map.
The old shared-graph path remains supported for existing files and excerpts.

Next stages: explicit replication/object
versions; seam-local dependency summaries; conflict-aware mixed revisions; custom
source namespaces and explicit multimodal connectors. Each needs reference-route,
restriction, missing-data and provenance tests before being advertised.
