# FIPS-first Atlas hosting

An Atlas host does not need a publicly reachable HTTP map origin. Its stable public identities are the publisher's Nostr public key, each immutable Hashtree root, and the FIPS provider's public key.

```mermaid
flowchart LR
  Library[Host library and serving choices] --> Offers[Signed map offers and default view]
  Offers --> Relay[Nostr discovery relay]
  Relay --> Client[Browser map composer]
  Client --> Reader[Atlas selective reader]
  Reader --> Cache[Verified local cache]
  Reader --> FIPS[FIPS encrypted mesh]
  FIPS --> Provider[Host blob service]
  Provider --> Files[Standalone .atlas files]
  Client --> RPC[FIPS map operations]
  RPC --> Registry[Existing operation registry]
  Registry --> Files
```

Discovery, delivery and computation have different jobs:

- **Nostr** publishes signed map capabilities, immutable roots, FIPS provider identities, seed hints and the host's proposed default composition. A client chooses trusted publishers; this is not a global search engine or proof that all maps have been discovered.
- **Hashtree** resolves Atlas byte ranges into hash-addressed blobs. Every blob is verified before use. The root pins the file revision independently of where it is served.
- **FIPS** carries blob reads and operation requests to an authenticated provider over the mesh. The prototype uses WebSocket seeds. The Atlas host itself needs no public DNS name or incoming HTTP port; seed and relay infrastructure can still use DNS.
- **Atlas** determines which display layers and analysis blocks to read. Geometry, labels, routing, search, raster and feature data use the same transport. Rendering and local tools still run on the consumer's device.

## Host controls

The **FIPS** tab shows the provider identity, connected seed peers, all published library roots, transfer counters and relay publication status. It controls FIPS delivery, bootstrap seeds, discovery relays and optional HTTP map delivery. Administration remains on the local/LAN HTTP host console.

FIPS is enabled by default. HTTP data and map-operation endpoints are disabled by default. Turning on HTTP advertises it as another delivery option. A FIPS client does not silently switch to HTTP: its Map panel has an explicit delivery choice and an explicit HTTP fallback permission.

Publishing an already indexed map updates its signed offer without recompiling or duplicating its `.atlas` file. Every served, published library map is available through the provider. Removing or unpublishing a map revokes new reads at that host and publishes a signed withdrawal. Already downloaded bytes cannot be recalled, and other providers may continue serving them.

The library's serving/capability choices still apply. Turning off an operation revokes server computation; it does not remove data already present in a publicly downloadable immutable file. To omit routing or another family from the downloadable data, prepare a package/revision without it. Consumers can independently choose not to read those blocks.

The host can mark a saved composition as its default view. Clients start with it when opening the publisher and may override both presentation and data selection. A view is a recipe referring to roots; it does not change those files.

## Connect a browser

Use the client link in the FIPS tab. It contains a trusted publisher and relay hints rather than a map-server URL, for example:

```text
http://127.0.0.1:5173/?publisher=<64-hex-publisher-key>&relay=wss%3A%2F%2Frelay.example&maps=<map-id>
```

`relay` can be repeated. Without `maps`, the host's signed default view is preferred. Signed offers supply the provider keys and bootstrap seeds. No HTTP catalog request is needed for this launch path. A selected map's identity is `htree://<root>`.

Explicit HTTP use is still supported with `?transport=http`. `?httpFallback=1` permits fallback for data reads when FIPS is selected. It does not authorize replaying a potentially stateful server operation on another provider. Browser files and deliberately local demo servers remain useful without any network discovery services.

Host federation and acquisition can likewise use a relay plus a pinned publisher to discover offers and read/mirror their files through FIPS. Mirroring produces a complete standalone `.atlas` file; FIPS changes delivery, not the file layout.

## Server tools

Port **39018** carries the existing Hashtree TCP blob protocol. Port **39019** carries Atlas operation RPC. These are FIPS service ports, not public TCP firewall ports.

An RPC request pins `{root, path, method, body}`. The server resolves the root only against currently served library maps, then invokes the same operation handlers and policy checks as HTTP. Routing, isochrones, search, extraction, workspace operations and registered custom tools keep their schemas, implementation pins and snapshot checks. Administrative routes are not exposed over RPC.

Responses preserve status and snapshot headers; offline exports can return binary Atlas bytes. Requests are bounded to 64 KiB; existing operation handlers may impose narrower input limits. Responses are bounded to 64 MiB JSON or 256 MiB binary, and operations have a ten-minute transport deadline. Cancelling the caller aborts its stream. Calls are not automatically replayed against another provider, because workspace operations can have state.

## Configuration and migration

On first startup:

| Variable                      | Meaning                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `ATLAS_FIPS_ENABLED=0`        | Disable mesh delivery, for an intentionally offline/local setup                                 |
| `ATLAS_HTTP_DELIVERY=1`       | Enable HTTP data and map operations                                                             |
| `ATLAS_FIPS_KEY_PATH`         | Existing persistent provider identity file; otherwise generated inside the FIPS state directory |
| `ATLAS_FIPS_SEEDS`            | Comma-separated WebSocket seeds                                                                 |
| `ATLAS_DISCOVERY_RELAYS`      | Comma-separated Nostr relays; empty disables relay publication                                  |
| `ATLAS_CLIENT_TRANSPORT=http` | Explicit HTTP default for a locally served client demo                                          |

Host UI choices are persisted in the data directory and take precedence over initial environment defaults. Back up the publisher and provider identity files privately. Never run two providers using the same private identity at once. When replacing the old preview sidecar, stop it before starting the integrated provider with its key.

A deployment can be staged with `bun run deploy --stage-only`. On the server, run the staged release’s `deploy/activate.ts prepare /home/nixuser/atlas 3100` with its Bun runtime to build and smoke-test without switching the live release. Activation still refuses active preparations.

`bun run demo` deliberately configures the standalone local HTTP workflow; FIPS-first production hosting does not require changing the easy offline demo.

## Verification and remaining boundaries

The test suite exercises two root-pinned maps through real FIPS/TCP stacks on an isolated local carrier, selective reads and cache reuse, provider failover, signed relay discovery/withdrawal, optional HTTP, binary RPC, custom operation execution and host revocation. A visible Brave smoke test loaded two signed maps, applied the signed default layer selection, and ran server search through FIPS without HTTP map/catalog requests. The repeatable acceptance setup used a loopback WebSocket mesh; public seed availability and throughput remain external dependencies.

The standalone Atlas browser contains this runtime directly. The Soyli napplet preview still uses its temporary shell bridge; production napplet.soy/Soyli bridge support is a separate integration. This does not implement a generic NAP networking API, access-controlled private maps, anonymous discovery, guaranteed relay availability, or automatic replay of stateful operations between providers.
