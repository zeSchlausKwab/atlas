# Operation plugins — first working slice

Implemented 2026-10-09. This is a trusted TypeScript plugin proof over one package. The wider [extension architecture](EXTENSIONS.md) remains the direction, with the boundaries below.

## Try it

Run `bun start`, then open the map at `http://127.0.0.1:3100/`.

1. Open **Tools → Largest lakes**. Zoom into an area (maximum width/height 0.25°).
2. Choose **Use visible area**, or **Draw area**, click at least three corners and **Finish area** / Enter.
3. Choose a **Lake definition**. `lake` is strictly OSM `water=lake`; `lake-and-oxbow` also includes `water=oxbow`, including Vienna’s Alte Donau. Rivers, ponds and reservoirs stay excluded.
4. **Run tool**, or **Compare device & server** on identical inputs. Choose the executor with the existing **Run tools on** selector.
5. **Select on map** sends the GeoJSON into Extract, where objects can be selected individually and exported as GeoJSON or polylines. **Download result** includes all returned objects, attribution, measurement semantics and provenance.
6. Open **Host console** in the header (`/host`). Disable Largest lakes, then refresh the server tool catalog. Both HTTP and MCP execution reject it. Re-enabling survives a server restart because policy is persisted in `data/host-policy.json`.

For a known central Vienna area, use Explore’s nearest-street input `48.2400, 16.4300`, zoom out four times to z13, then select `lake-and-oxbow`. A strict lake-only example is farther east around `48.1800, 16.5300` at z13.

Host switches control **server execution**. They do not revoke public archive bytes or a consumer’s independently installed device tool. Local administration requires a loopback peer/hostname; browser writes require a matching Origin and JSON content type. This is not a remotely authenticated administration system.

## The actual contract

`packages/operations/src/registry.ts` owns registration, input/output validation, snapshot-compatible availability, enablement and implementation identity. The seven existing operations are adapters in `builtins.ts`. Their convenience methods and legacy HTTP URLs remain supported; a custom plugin does not add an operation enum case.

An extension exports a `Plugin`:

```ts
import type { Plugin } from "../packages/operations/src/registry";

const plugin: Plugin<MyInput, MyResult> = {
  descriptor: {
    id: "myorg.example",
    version: "1.0.0",
    title: "Example",
    description: "Define the geographic question and units here.",
    inputSchema,
    outputSchema,
    requirements: [
      {
        capability: "feature-extraction",
        family: "features/water",
        schema: "features-v1",
      },
    ],
    purposes: ["features"],
    result: "geojson",
    execution: ["device", "server"],
    federation: "single-executor",
  },
  validate(input) {
    /* optional semantic checks beyond JSON Schema */
  },
  async run(input, context) {
    for await (const object of context.data.scanFeatures(query)) {
      context.signal.throwIfAborted();
      // Accumulate or transform data, preserving object IDs.
    }
    return result;
  },
};
export default plugin;
```

Add its entry path to `atlas.plugins.ts`, then restart. The build creates a self-contained ESM bundle and SHA-256 filename in `dist/plugins/`. The host imports those bytes. The browser worker verifies the same digest before importing them. Only the build’s installed allowlist can execute on the device; discovering an unfamiliar remote operation does not install its code.

Descriptors generate the host rows and Tools forms, including an `x-atlas-widget: "polygon"` hint. JSON fields are the fallback for complex inputs. GeoJSON source-feature results reuse the selection renderer. A different result family still needs a compatible presentation adapter; arbitrary plugin HTML is not loaded.

The legacy core adapters currently use the manually versioned implementation token `atlas-core-1`. Custom plugin bundles have actual code digests. Core artifact hashing, signed publisher identity and runtime ABI negotiation are later steps.

### Lake semantics and limits

The example is in `plugins/lakes.ts`. It scans **only `features/water`**, deduplicates stable source IDs across cells, intersects the requested polygon, calculates spherical square-metre area of each **whole retained geometry**, subtracts holes and retains multipolygon components. It scans before selecting the top N; the feature-extraction UI’s 500-result cap does not bias rankings. Equal areas use stable IDs as a tie-break.

The selection controls which objects qualify, not which portion of their area is measured. Geometry can already be incomplete at the source boundary. Results therefore always state source-extract coverage. Unknown water classifications are counted; if all intersecting water polygons lack classification, the tool fails explicitly. This does not infer missing OSM tags or equate all blue polygons with lakes.

Scans reject regions larger than 0.25° in either axis, more than 64 MiB of decoded feature blocks, or more than 100,000 matching objects. These are implementation limits, not just descriptor hints. The host queue accepts at most eight pending computations and serializes HTTP and MCP work together. Trusted host plugins are **not sandboxed** and have no hard CPU deadline; the browser worker can be terminated. No resumable checkpoints or streamed partial results yet.

## HTTP

`GET /api/capabilities` retains the v1 compatibility catalog and adds `plugins` with schemas, enablement, data availability and implementation identity. Invoke the chosen descriptor:

```ts
const catalog = await fetch("/api/capabilities").then((r) => r.json());
const tool = catalog.plugins.find((p) => p.id === "atlas.lakes.rank");
const response = await fetch(`/api/${tool.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    snapshot: catalog.snapshot,
    version: tool.version,
    implementation: tool.implementation,
    input: { polygon, limit: 10, classification: "lake-and-oxbow" },
  }),
}).then((r) => r.json());
// { result, execution, provenance }
```

Stale snapshot/code identity returns 409; disabled operations return 403; invalid inputs fail before data access. Request bodies are limited to 16 KiB. The result envelope records operation/version/code digest and the package snapshot. Offline `.atlas` export keeps its existing binary HTTP endpoint.

## ContextVM

This is an actual `@contextvm/sdk` Nostr transport around an MCP server. `tools/list` and `tools/call` use the same registry/executor as HTTP. Each operation gets its own tool name and input/output schemas. Inputs contain `snapshot`, `implementation` and `input`. Binary offline export remains HTTP-only; large downloadable MCP artifacts are a future adapter.

Run a self-contained proof against the real Vienna archive:

```sh
bun run demo:contextvm
```

It starts an isolated loopback Nostr relay, creates ephemeral server/client signers, connects a real MCP client, lists tools, invokes lake/oxbow ranking, compares it with native execution, prints a compact result and closes everything. It sends no public announcements and touches no public relays.

To enable ContextVM alongside the normal server, configure `ATLAS_CVM_SECRET` (server hex private key), `ATLAS_CVM_RELAYS` (comma-separated relay URLs), and `ATLAS_CVM_CLIENTS` (allowed client public keys), then run `bun start`. These must be supplied by the operator; no credentials are generated or persisted by server startup. Announcements and relay-list publication remain disabled in this slice. The host console reports whether the transport is connected.

## Cache and offline behavior

Plugin reads go through the existing verified AtlasReader and shared browser block store. The worker performs JSON decoding and geometry work. Plugin code is fetched only when invoked and cached by the offline shell; an already used tool can run without a connection when its needed archive blocks are cached. Cold misses are errors, not empty answers. Local `.atlas` files use the same reader path.

Code artifacts have content-addressed URLs; changed code has a new digest and cannot silently satisfy an old invocation. There is **no operation-result cache yet**, so results cannot be reused across incompatible code/input revisions. Purge caches terminates active tools, disposes readers and clears plugin code along with the Atlas app shell and block store. Preferences and host policy remain intact.

## Verified and deferred

The test suite covers rank-after-scan (>500 candidates), deduplication, holes/multipolygons, explicit oxbow selection, unknown classifications, input/output schemas, cancellation before reads, offline misses, exact bundled/native equivalence, arbitrary plugin registration, host policy persistence/origin checks and real ContextVM discovery/invocation/revocation through a local relay. Existing operation tests still cover route, all transport modes, reachability, search, reverse geocoding and offline export.

The final Bun suite passes **87 tests**, and TypeScript checking and the web build pass.

Visible browser checks cover device/server equality, finishable polygons, selected GeoJSON/export, warm offline execution, host disable/re-enable and mobile layout. One Vienna-plus lake-only run read about **0.58 MB** of source data on the device; the equivalent server result was **3.2 KB**. The 10-result central Vienna lake/oxbow run read **0.81 MB** locally and returned **123.5 KB** from the server, including selectable polygon geometry; an offline rerun read **0 additional bytes**. These are operation transfers, not the entire map or planet estimates.

Deferred: multiple package installation/provisioning, Nostr offer announcements, Hashtree delivery, federation, recipe planning, build/index plugins, Wasm plugin ABI, host isolation/quotas, result caching, and a `.atlas` derived-layer writer. The current derived layer is portable **GeoJSON with provenance**.
