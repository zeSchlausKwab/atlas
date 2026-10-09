# Extensible geographic capabilities

Architecture direction — 2026-10-09. The first trusted TypeScript operation slice is now implemented; see [the runnable plugin demo and current boundaries](PLUGIN-DEMO.md). The broader planning, build-plugin and federation interfaces below remain proposals. It extends [the hosting discussion](HOSTING-DISCUSSION.md).

## Principle

Atlas provides geographic data access and execution contracts. The operations shipped with Atlas are plugins using those contracts. Hosts can add operations, data families and derived indexes without changing a central operation enum, HTTP dispatcher, client library or archive version for every extension.

We do not need universal agreement on every geographic question. A plugin author defines a question precisely, publishes a versioned contract and supplies its implementation. Other implementations may adopt that contract; alternative meanings use different contracts. Consumers can discover and invoke unfamiliar capabilities without pretending that similarly named tools are equivalent.

## Two interfaces, separate responsibilities

The consumer-facing interface describes and invokes capabilities. Conceptually:

```ts
const operation = await atlas.capabilities.describe(operationRef, scope);
const result = await atlas.invoke(operation.ref, input, {
  scope, // pinned dataset revisions + geography
  execution: "auto", // or "device" / "server"
  signal,
});
```

`operationRef` identifies the publisher namespace, semantic contract version and pinned implementation/offer where needed. Display names are not identifiers. Automatic execution considers required imports/data, trusted implementations, coverage, budgets and the consumer's policy; it must not silently move a request to a different executor when policy requires device-only or server-only execution.

The author-facing interface gives a plugin access to data and computation. A deliberately small lifecycle sketch:

```ts
interface AtlasOperation<Input, Output> {
  descriptor: OperationDescriptor;
  plan(input: Input, context: PlanningContext): Promise<OperationPlan>;
  run(
    input: Input,
    context: ExecutionContext,
  ): AsyncIterable<OperationEvent<Output>>;
}
```

These are illustrative types, not SDK code. `plan` reports prerequisites, available coverage and bounded estimates. It can report that cost/dependencies will be discovered during execution; routing cannot promise an exact list of cells before searching. Planning itself has a budget and must not conceal an expensive full-data scan. A runtime may provide a default plan from static dependencies for simple plugins.

`run` emits progress, partial output, missing-data requirements, final output or a typed failure. Partial output never implies complete coverage. Cancellation, memory/time/read limits, backpressure and result validation are runtime responsibilities. Plugins receive scoped handles rather than ownership of global caches or raw unrestricted source access. A killed runtime need not be resumable; resumable operations must declare and version their checkpoint format and validate pinned inputs on resume.

## A plugin descriptor

One plugin can register several operations. Each operation declares:

| Field                                           | Purpose                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Stable operation identity and semantic contract | Publisher namespace, meaning/version, documentation and conformance cases                                     |
| Input/output schemas                            | Structural validation and generated clients/forms; geometry CRS/axis order and units are explicit             |
| Data requirements                               | Required and optional schemas, fields, relationships and indexes; acceptable revisions and completeness       |
| Implementation identity                         | Plugin revision and immutable code digest; runtime/import ABI versions                                        |
| Execution support                               | Host, client, or both, with required imports and external dependencies                                        |
| Result behavior                                 | Output type, streaming/checkpoint support, completeness/provenance and determinism                            |
| Requested permissions and resource hints        | Data scopes, optional external services, expected cost and execution needs                                    |
| Federation contract                             | Default one executor; optionally portable execution over a collection or an explicit partition/merge protocol |

Host configuration separately sets enabled datasets, granted permissions, enforceable limits, pricing/access rules and publication. A plugin cannot grant itself access or raise its own quotas by editing its descriptor. Cost hints and completeness claims are claims to validate, not enforcement mechanisms.

Input/output schemas alone do not establish equivalent meaning. Two `longest-road` tools can share the same JSON shape but disagree on whether a road means an OSM way or a named connected road. Semantic contracts and test vectors carry that distinction. No central Atlas approval is required to define a private/custom namespace.

Availability is evaluated for the requested scope and execution location. The UI can distinguish enabled, partially covered, missing data/index, unsupported runtime and disabled by host policy. A package containing raw features may permit a scan but lack the index needed to satisfy a particular host's latency budget.

## Extensibility at three places

### Recipes

A declarative composition of existing operations handles common filtering, projection, spatial joins, aggregates and exports. Examples: lakes above a given area; buildings within a walking catchment; the highest known peak in a polygon. Recipe semantics include handling unknowns, duplicates, clipping and partial coverage.

Recipes are an accessible authoring layer over the same operation runtime. They do not limit authors who need a new algorithm. A typed plan can support filter pushdown, shared reads and streaming, but an optimizer must preserve geographic semantics, units and completeness.

### Computation plugins

Custom code implements algorithms such as wheelchair-aware routing, building shadows, visibility, flood exposure, slope-aware cycling or specialized search ranking. A host can also wrap an existing database, native executable or external service. Such a wrapper identifies its additional data sources and may be host-only or non-deterministic.

The plugin-facing data interface should offer scoped, batched access to features/properties/geometry, graph cells and registered index/raster schemas. Projection matters: an area aggregate should not decode building geometry when a validated area column is enough. Streams should use batches or binary buffers for large payloads; JSON tool envelopes need not force millions of JSON objects through the inner computation loop.

Plugin authors should not implement HTTP ranges, provider selection, decompression, cache eviction or integrity checks. The data module owns these. A versioned low-level block interface can support a new custom index before a higher-level accessor exists. Missing indexed coverage must propagate explicitly rather than appear as an empty feature stream.

### Data and build plugins

Some computations require information our current archives omit. Import/build extensions can ingest another source, retain extra OSM tags/relations, calculate derived columns, and create indexed block families. Examples include elevation grids, building height/roof attributes, surface/smoothness, shade estimates, administrative relationships or a custom routing hierarchy.

A build extension declares source revisions, compiler/configuration identity, input schemas and produced schemas. Its output can be packaged, verified, selectively downloaded and advertised like built-in data. Preserve stable object identities so a derived table can join to its source geometry. Materialized results carry provenance and create a new immutable revision; they do not mutate an existing package in place.

Unknown optional families can be ignored by readers. A requested operation requiring an unknown codec/schema must fail explicitly. Installing one custom plugin must not make an unrelated map-only client download it or its data.

## Execution choices

| Authoring/execution option        | Intended use                                                         | Portability                                                           |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Trusted TypeScript/Bun plugin     | Host customization and wrapping today's engine                       | Host by default; browser support only when its dependencies permit it |
| Portable Wasm module              | Shared algorithms over Atlas-provided imports                        | Browser worker and native/server adapters after compatibility tests   |
| Native process or external module | Existing heavy engines, special hardware, private databases/services | Host-only unless another compatible implementation exists             |

Wasm is a useful portable target, not a requirement that every plugin must satisfy. The Component Model/WIT is a candidate for the typed binary interface. Its richer interface types and canonical ABI address cross-language calling conventions; browser delivery still needs compatible tooling/bindings and implementations of the imports. Evaluate that against the current Rust/core-Wasm pipeline before choosing an ABI.

The runtime grants data access through imports. A trusted Bun plugin has the permissions of its process unless we isolate it; it is not sandboxed merely because it implements our interface. Browser plugins run off the UI thread and can be terminated. Host runtime limits need to cover guest computation and host-side data functions. Installing an operator's code and discovering a remote host's advertised code are distinct actions: discovery does not automatically authorize client execution.

The useful promise is: **portable plugins can execute unchanged over compatible data on either side; other plugins remain callable remotely through the same consumer interface.** Each advertised implementation states which promise it meets. Floating-point results and external inputs need declared comparison/caching semantics; Wasm alone does not make a computation deterministic.

## ContextVM, HTTP and the UI

One registry is authoritative. For an enabled plugin operation:

- The ContextVM adapter exposes a named MCP tool with input/output schemas and the Atlas contract/offer reference.
- The HTTP adapter dispatches through the same validation and lifecycle.
- The client can generate typed wrappers or invoke by schema at runtime. Existing convenience methods such as `route()` remain wrappers.
- The host console displays dependencies, configuration, availability, limits and installation/update state.
- A generic consumer Tools panel can generate basic forms, with optional declarative hints for a map-picked point, polygon, distance, profile or time range.

Individual named MCP tools keep discovery useful. A generic Atlas `invoke` interface does not require reducing every MCP capability to a single opaque `execute-anything` tool.

Standard result types let new tools work with the existing map: GeoJSON features, paths, points, tables, scalar results, rasters and downloadable artifacts. A new tool returning compatible GeoJSON can be selected, styled and exported without adding UI code. Large output uses paged/binary/artifact delivery as appropriate. A specialized renderer or richer UI is a separate opt-in extension; arbitrary plugin HTML is not the default output format.

Nostr announcements advertise host offers and reference plugin/contract identities. Hashtree can distribute immutable plugin artifacts and derived data. Provider identity, plugin-author identity, semantic contract identity and code digest remain separate. Native code/compiled runtime caches are not interchangeable with portable Wasm binaries.

## Federation and caching

Two hosts exposing the same tool name does not mean their results can be combined. Default to one executor. An extension can explicitly support one of these further strategies:

- Execute a portable implementation over the consumer's compatible union of data.
- Execute on partitions and merge using a specified algorithm, ownership/deduplication policy and completeness rules.

A maximum is mergeable over complete compatible partitions. A mean needs sum/count, with duplicate handling. A longest connected road may span partitions and needs connectivity information; choosing the longest local fragment is incorrect. Routing across hosts still uses compatible graph cells rather than concatenating independently calculated routes. Complex plugins can supply a coordinator implementation instead of pretending they fit a generic reducer.

Cache deterministic results by contract/version, implementation digest, normalized inputs, pinned dataset/dependency revisions and relevant configuration. Include scope/completeness and partition ownership where they affect meaning. Authorization-dependent results stay partitioned by access scope. Live external data requires a revision or an explicit freshness policy; the map snapshot alone is insufficient. Plugin upgrades must not silently reuse incompatible previous results.

## Implementation path and proof

The prototype now retains typed `OperationInputs`/`OperationResults` for existing convenience APIs, while a registry supplies open-ended plugin dispatch for HTTP, MCP and the Tools panel. The compatibility capability catalog remains alongside the new descriptor list. There is no need to rewrite the renderer or routing algorithm to establish the registry.

First proof:

1. Register existing peak query and feature extraction as ordinary plugins.
2. Install an independently authored **lake area ranking** plugin. Given a polygon, return the largest recorded lakes, their areas and selectable geometries. Specify whole-object versus clipped area and source completeness. Missing lake tags should produce an explicit unsupported-data result, not relabel every water polygon as a lake.
3. Have it appear in the host console, generic consumer Tools panel, HTTP catalog and ContextVM tools without adding operation-specific branches to those modules.
4. Run the portable implementation locally and remotely on the same snapshot; verify defined result equivalence, cancellation, missing-data behavior and selective reads.
5. Package its output as a derived layer. Demonstrate disable/update behavior and cache invalidation by plugin digest.

This proof tests the abstraction through a real additional adapter. Future flood/shade/transit examples may need extra data/build extensions and should state that prerequisite.

## Primary references

- [MCP tool schemas and structured outputs](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- [ContextVM tool transport](https://docs.contextvm.org/reference/spec/ctxvm-draft-spec/).
- [WebAssembly Component Model and WIT](https://component-model.bytecodealliance.org/design/why-component-model.html).
- [Wasmtime imports and sandbox model](https://docs.wasmtime.dev/security.html).

These references establish underlying mechanisms. [PLUGIN-DEMO.md](PLUGIN-DEMO.md) distinguishes the implemented registry/HTTP/MCP/worker proof from the broader proposed lifecycle and distribution model.
