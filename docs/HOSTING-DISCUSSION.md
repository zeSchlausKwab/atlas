# Hosting, capabilities and composed maps

Discussion draft — 2026-10-09. Cache controls and the first single-package host console, operation registry and ContextVM adapter are implemented; see [PLUGIN-DEMO.md](PLUGIN-DEMO.md). Multi-package provisioning, announcements and federation below remain proposals.

Historical decision (superseded for new RCL3 routing by [OSM-authoritative federation](ROUTING-FEDERATION.md)) from this discussion: the first Vienna–Bratislava federation demo uses slices of **one shared source snapshot**. Compile once and partition the canonical output; independent compilation of different extracts is not yet a compatibility guarantee.

## The model

A map presented to a person should be a **view**. It may resolve data from a local file, one server, several mirrors, or compatible adjoining packages. Its presentation style belongs to the consumer. The data and operations available underneath it are explicit.

| Concept          | What it declares                                                                                                    | Who controls it             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Dataset revision | Source revision, compiler/schema/profile versions, stable feature identities, immutable authenticated block catalog | Dataset producer            |
| Package          | Selected geography, data families, representation/detail levels, dependency closure, completeness and attribution   | Producer or excerpt builder |
| Host offer       | Package/root, delivery endpoints, enabled remote operations, limits, availability and optional price/access policy  | Hoster                      |
| View             | Required coverage/layers, style, preferred providers, freshness and execution policy                                | Consumer                    |

Two hosts can offer the same package with different compute policies. A client may download routing data and compute locally even if the host does not offer a routing tool. Conversely, a host may offer routing results without offering graph downloads. Disabling a server operation does not revoke capabilities inherent in already downloaded public data.

A compact country-boundary package in a frontend asset folder remains a complete supported deployment. No discovery connection, service, routing engine, or identity is necessary to display it.

## What gets packaged

Separate three independently selectable families:

- Display representations: generalized geometry by layer and zoom, labels, raster/terrain when available.
- Semantic objects: identities, original geometry, properties and relationships needed for extraction, joins and factual queries.
- Operation indexes: text/spatial search, routing cells and profiles, aggregate summaries and future routing hierarchies.

Display zoom is not semantic completeness. A z4 picture of a mountain does not certify that every peak is included. A blue water triangle does not establish that the feature is a lake or preserve its original polygon.

Examples of distinct products a host could install:

| Package                            | Data                                                              | Remote operations                                                      |
| ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| World countries                    | Generalized country polygons, stable identifiers, names           | None required; ideal static asset                                      |
| World water + administrative areas | Chosen water detail and boundary hierarchy through municipalities | Lake extraction only if semantic lake objects are included             |
| Planet display                     | Selected display layers and zooms                                 | None required                                                          |
| Austria complete                   | Display, semantic objects, search indexes, routing profiles       | Route, isochrone, search, reverse, extraction and supported aggregates |

Administrative hierarchy is a semantic selection separate from zoom. We still need a boundary importer/representation for the first two examples; the current archive is not a ready-made global administrative dataset. Global coverage needs a suitable global source even if the resulting package is tiny. A regional file cannot supply missing world geometry.

The selector should show dependencies before download: choosing bicycle routing brings the bicycle graph/indexes; choosing lake extraction brings lake objects and a spatial index. It should not silently include unrelated rendering layers. Geometry-only extraction should have its own representation when source polygons are wanted without names or other attributes.

## Defining tools and query meaning

A host installs custom plugins and enables their versioned operations and allowed parameters. Registration is an open extension mechanism, not an Atlas-maintained whitelist. Plugin authors define their semantics; the built-in operations below are examples. Effective availability is the intersection of installed implementations, package data, runtime support and host policy. See [Extensible geographic capabilities](EXTENSIONS.md) for the proposed registry, author interface and data/build extensions.

| User phrase        | Suggested operation                       | Required definition/data                                                                                                                                              |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find highest peak  | `atlas_peak_max`                          | Scope; peak classification; numeric elevation and datum/units; unknown-elevation handling; complete candidate coverage                                                |
| Find longest road  | `atlas_road_rank`                         | First define road: OSM way, named connected road, or route relation; measure clipped length or whole-object length; define distance method and identity/deduplication |
| Allow lake extract | `atlas_extract_features` with kind `lake` | Explicit lake classification; retained polygons/holes and IDs; spatial index; clipped versus whole intersecting objects; limits and pagination                        |
| Routing            | `atlas_route`                             | Snapshot/package collection, origin/destination, profile and cost-model version, graph coverage, restrictions                                                         |
| Isochrones         | `atlas_isochrone`                         | Same traversal semantics as routing; origin, profile, time bands, contour algorithm/version                                                                           |
| Search / geocoding | `atlas_search`, `atlas_reverse_geocode`   | Query/coordinate, scope and optional bias; language/ranking semantics; source completeness                                                                            |

“Highest known recorded peak in this covered area” can be answered honestly with missing elevation counts. “Highest mountain in Europe” needs a definition of Europe and verified candidate coverage for that scope. Return the definition, snapshots used, coverage, unknowns, truncation and completeness with the result. A host signature authenticates the provider; a content hash authenticates bytes. Neither alone proves that an aggregate was calculated correctly or that the source maps the real world completely.

A typed recipe interface can express filters, joins, `argmax`, sums and ranking over registered fields. Custom code plugins handle algorithms that recipes cannot express, and build plugins can add their required data/indexes. Host authors may use TypeScript, Wasm or adapters to native/external engines. Interoperability comes from the descriptor, schemas, semantic contract and execution lifecycle; implementation code remains extensible. Portable plugins can run on both host and client, while host-specific implementations are advertised as remote-only.

## ContextVM as a first-class interface

The same typed operation contract should drive local calls, HTTP handlers and ContextVM tools:

```text
Map UI / app / ordinary MCP client
        │
        ├─ local execution ───────────────┐
        ├─ HTTP operation adapter ────────┤ shared contracts and operation engine
        └─ ContextVM MCP tools adapter ──┘
                                         │
                                  verified block resolver
```

Expose `atlas_route`, `atlas_isochrone`, `atlas_search`, `atlas_reverse_geocode`, `atlas_extract_features` and the supported query tools. Use resources or `atlas_list_packages`/`atlas_describe_package` for the catalog. All operation inputs pin immutable revisions; every result identifies its actual input revisions and operation version. Errors distinguish unsupported capability, unavailable coverage, missing bytes, budget exceeded and an actual negative result.

A conceptual call (proposed, not the current API):

```json
{
  "name": "atlas_isochrone",
  "arguments": {
    "collection": "<pinned collection root>",
    "origin": [16.373, 48.208],
    "profile": "bicycle",
    "seconds": [300, 600, 900]
  }
}
```

Small results return inline. Large GeoJSON/exports return a hash, size, schema, expiration if applicable, and retrievable artifact references. ContextVM already specifies oversized-payload transfer; compare that mechanism with explicit reusable geographic artifacts instead of inventing another relay chunk protocol. Cancellation, progress and limits belong in every adapter. A tool is callable by normal application code; an LLM is optional.

The existing `AtlasEngine`, typed operation contract and capability catalog are the starting seams. The current API serves one configured package and has no ContextVM transport. Add a catalog-aware operation service and thin adapters, with one test vector suite proving local/HTTP/CVM agreement.

Public tools and administrative tools are separate registries. Installing a package, removing it, changing quotas or announcing an offer belongs to authenticated operator access. The hosting UI can use that same admin service without making disk mutations public MCP tools.

## Nostr and Hashtree

Proposed responsibilities:

- **Nostr:** provider identity, signed current announcements and links to catalogs/immutable roots.
- **ContextVM:** tool discovery, request/response computation, progress and negotiated service policy.
- **Hashtree:** immutable content addressing and retrieval through its supported transports.
- **HTTP ranges and local files:** efficient compatible byte-delivery paths under the same operation/rendering APIs.

ContextVM CEP-6 already advertises servers and their tools/resources. One provider key has one replaceable announcement per announcement kind. Do not announce each hosted map as a separate server event under the same key: later events would replace earlier ones. Announce a host catalog, with independently addressed package descriptors and a spatial catalog index. Put coarse searchable hints on discovery records and exact coverage/dependencies in authenticated descriptors. Refresh reachability and expiration; an old signed advertisement is not proof of current availability.

Keep dataset identity separate from provider identity. Another host can mirror the same immutable package. The consumer pins a revision for a session and switches mirrors by verified identity, not by whichever host replies with a newer-looking map.

Hashtree's current core protocol uses immutable hashed blobs/tree nodes and mutable Nostr roots. Its documented default chunk size is 2 MiB, which is not a protocol constant. Wrapping a giant `.atlas` blindly at that granularity could amplify our kilobyte-scale tile reads. Prototype both whole-file range access and an Atlas-block-aligned tree; measure fetched bytes and round trips. Preserve complete CIDs, including encryption keys when present. Do not assume every hash is a plaintext Atlas block hash.

Longer term, a `.atlas` file can be a portable packed projection of a canonical block collection. A Hashtree representation can reference those same logical blocks. Independent packages currently use offsets and snapshot-scoped caches; cross-package deduplication and an authenticated collection directory need explicit format work. Deduplication is earned through identical canonical bytes, not merely similar geographic coverage.

## The host management UI

Start with four screens:

1. **Library:** installed packages, exact disk usage, coverage, revision, supported data and enabled operations. Separate storage from RAM/CPU budgets.
2. **Acquire:** choose a trusted upstream package, draw/select geography, choose layers, detail, semantic families and tool dependencies, preview required bytes, then install. Show whether this is copying indexed blocks or compiling/clipping new data.
3. **Offers:** enable delivery and remote tools per package; configure supported profiles, area/result/time/concurrency limits; preview the exact advertised descriptor. Show publication and current health separately.
4. **Jobs and storage:** download/verification progress, pause/resume, failures, reserved space, retained revisions and garbage collection.

Install lifecycle: plan dependencies → reserve space including temporary/update overhead → resumable download → verify hashes and catalog → atomically make package available → advertise. Never advertise a capability from an incomplete download. Restart must recover jobs and the registry. Revisions used by active readers remain pinned while replacements install. Retention and removal operate on references so shared blocks are not deleted while another package needs them.

A server with limited storage can choose narrow geography or fewer families; a server with limited CPU can offer static delivery only. Source production is a separate role: hosters should be able to acquire existing packages without running an OSM compiler.

## Vienna + Bratislava: what “stitch” means

There are three different problems:

1. **Mirrors:** several providers serve the same hash. Retry/fail over, verify and cache once.
2. **Compatible coverage:** providers serve different pieces of one collection. Resolve each requested layer/cell from the appropriate offer and render a common view.
3. **Alternative datasets:** providers disagree in revision, identities, schema or geometry. This requires explicit precedence/reconciliation; it is not transparent mirror failover.

For display, use canonical tile/layer ownership and deterministic overlap precedence. Clip to ownership regions where necessary; preserve halos for geometry/labels but avoid double fills and duplicate labels. Keep attribution and coverage gaps visible. Equal zoom ranges alone do not establish compatibility.

For routing, padding is useful but insufficient. We need stable cross-package node/edge identities, canonical cells, owner versus halo semantics, equivalent directional costs/profile versions and complete boundary turn rules. The current RCL codec uses segment indexes from the compiled graph as edge IDs. Two separately compiled extracts can assign different IDs even from the same PBF date. The first demo must partition cells from the same compiled graph, with dependencies intact; future independent builds need globally reproducible identities and compatibility fingerprints.

A client search that encounters an unresolved frontier asks the collection resolver for the missing graph cells, regardless of host. It continues when cells arrive. If they cannot be obtained, the result is partial/needs-data, not “no route.” Optimality and completeness are scoped to the covered compatible graph; unknown outside detours can affect a route. General long-distance routing still needs the hierarchy work described in STACK-REVIEW.md.

Search and aggregate federation also need semantics: deduplicate stable IDs, do not compare arbitrary per-host ranking scores, and distinguish full coverage from best-known partial results. A maximum can be combined from compatible complete partitions; a globally longest road cannot be determined by selecting the longest clipped road fragment from each host.

## Suggested proof sequence

1. Establish the open operation registry using existing operations and an independently authored plugin, then multi-package local host UI with disk persistence and honest dependency/space previews. Serve a small display-only package and a fuller regional package together. Export/reopen a tiny standalone file.
2. ContextVM route, isochrone and search tools over the existing shared engine. Same snapshots/inputs must match local and HTTP results. Begin with local relays and no public announcements.
3. Signed catalog discovery plus two mirrors of the same immutable blocks. Demonstrate failover and cache reuse, then a Hashtree adapter with measured range/chunk overhead.
4. Two hosts serving complementary slices of the same compiled Vienna–Bratislava collection. Prove continuous display, then a cross-boundary route and isochrone with on-demand cell fetch and offline replay.
5. Independent sources/revisions, global semantic indexes and routing hierarchy after those contracts hold.

Open choices for discussion: whether a view may silently use older data when a host is missing (recommended default: pin and disclose any fallback); whether clients select named host-curated packages, describe desired geography/capabilities, or support both (recommended: curated presets backed by a common declarative recipe).

## Verified primary references

- [ContextVM protocol and MCP tool calls](https://docs.contextvm.org/reference/spec/ctxvm-draft-spec/).
- [CEP-6 server and capability announcements](https://docs.contextvm.org/reference/ceps/cep-6/).
- [CEP-22 oversized transfer](https://docs.contextvm.org/reference/ceps/cep-22/).
- [ContextVM TypeScript SDK](https://github.com/ContextVM/sdk).
- [Hashtree overview and implementations](https://github.com/mmalmi/hashtree).
- [Hashtree core protocol, identity and chunk defaults](https://github.com/mmalmi/hashtree/blob/master/docs/HTS-01.md).
- [Hashtree networking and provider lookup semantics](https://github.com/mmalmi/hashtree/blob/master/docs/NETWORKING.md).

The sources verify the underlying projects; Atlas contracts and UI above are our proposal. Protocol details should be pinned to versions when implementing the adapters.
