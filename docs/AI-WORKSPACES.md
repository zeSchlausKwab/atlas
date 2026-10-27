# AI task workspaces v1

A model chooses a bounded geographic scope and data families. Atlas prepares a pinned
local working set and runs repeatable queries without putting whole map geometries
into the model context. The same engine runs in the browser or on the server.
Every source dataset remains one self-contained `.atlas` file. Workspaces and result
references are temporary runtime state, not required sidecar files.

## Try it

```sh
bun run demo:workspace
```

This needs only installed dependencies, no remote server or network. It writes two
small synthetic `.atlas` files into a fresh `/tmp/atlas-workspace-demo-*` directory,
prepares their overlapping coverage, closes both source readers, then queries cafés,
explicit wheelchair access, an address and building heights. It asserts **zero further
source reads**. Generated files are left there for inspection.

In the normal client, open **Tools** and select **Describe the data**, then
**Prepare a local task workspace**. Enter a bounding box up to 0.25° across and
families, for example `["locations", "buildings"]`. Select `required` values
`["addresses", "poi-tags"]` if those fields are needed. Choose **Query cached data**;
the previous workspace reference is filled in. **Read a result page** carries the
last result reference forward. Workspace references are separate for device/server.
**Release a task workspace** frees its data and invalidates its results.

Device workspaces use the selected composition. Server workspaces use the selected
Tool source. The old Search/Extract convenience tools remain scoped to Tool source.
Data settings still govern preparation; changing execution mode or disabling a
purpose invalidates local workspaces. Stateful tools cannot use the device/server
comparison button because references are local to one executor.

Existing maps expose their existing data. House-number retention requires a new
build: this change does not add addresses to Britain or old Vienna files retroactively.

## Library contract

```ts
import { AtlasWorkspace } from "../packages/workspace/src/index";

// Readers have already opened verified file/range sources.
const tasks = new AtlasWorkspace([westReader, eastReader]);
const catalog = tasks.catalog(); // metadata only
const task = await tasks.prepare({
  bounds: [16.36, 48.20, 16.39, 48.23], // west, south, east, north
  families: ["locations", "buildings"],
  required: ["addresses", "poi-tags"],
  maxReadBytes: 16 * 1024 ** 2,
});
const cafes = tasks.query({
  workspace: task.workspace,
  where: [{ field: "tags.amenity", op: "eq", value: "cafe" }],
});
const accessible = tasks.query({
  workspace: task.workspace,
  from: cafes.result,
  where: [{ field: "tags.wheelchair", op: "eq", value: "yes" }],
});
const page = tasks.result(accessible.result, 0, 20,
  ["id", "name", "coordinates", "tags.wheelchair"]);
tasks.release(task.workspace);
```

`query` also accepts exact OSM `ids`, text and typed `eq`, `exists`, `gte`, `lte`,
`contains` filters. Missing values return `null`. `exists:false` selects unknowns;
unknown is never interpreted as false. Heights are metres above ground and carry
`tagged`, `levels-estimate` or `unknown` provenance. Filtering by identity is scoped
to the prepared workspace; there is no global feature-ID index yet.

The shared operation registry exposes `workspace_catalog`, `workspace_prepare`,
`workspace_query`, `workspace_result`, `workspace_release`. They work through the
normal `/api/<operation>` and `/maps/<id>/api/<operation>` routes and ContextVM/MCP.
HTTP requests pin the package snapshot; MCP also pins the implementation. ContextVM
must be configured explicitly and still exposes the configured base source. No
public relay publication or arbitrary plugin execution is introduced here.

## Coverage, identity and resource rules

- `complete` means complete for the requested families within retained source data.
  OSM real-world completeness remains unknown. Political containment is unsupported;
  a nearby settlement name is not an administrative parent.
- Coverage uses the union of providers' selection polygons/bounds, separately for
  each family. Gaps or omitted families fail unless `allowPartial:true` is explicit.
  Required address/POI-tag retention must also cover the area. Partial status follows
  every result and page, including empty answers.
- Composition requires a shared source revision or parent snapshot. Overlapping
  objects deduplicate by family plus OSM ID; inconsistent source attributes or
  geometry fail rather than picking a winner. This is not a reconciliation engine
  for independent snapshots or differently clipped geometries.
- `cacheOnly:true` prepares from the reader's verified cache/persistent store and
  never fetches missing blocks. Prepared rows stay pinned independently of reader
  eviction/closure. Browser persistence now also admits search, feature and query
  blocks into its existing bounded LRU; persisted blocks are not permanently pinned.
- At most two workspaces per engine, each with up to 64 MiB estimated working data,
  up to 64 MiB source reads and 100,000 records. Default read budget is 32 MiB.
  Estimates charge five times each decoded block's bytes before loading, and are
  not a hard process RSS cap. Pre-opened metadata, parser/runtime overhead and
  separate renderer/routing caches are not a claim of total process memory.
- References expire after 30 minutes and are invalid after release, purge, session
  destruction or restart. Up to 64 result references, with 8 MiB of estimated index
  storage, and 100 rows/256 KiB per result page. Default previews omit geometry.
- Errors carry `invalid_request`, `unsupported_data`, `outside_coverage`,
  `missing_blocks`, `budget_exceeded`, `conflicting_data`, or `expired_reference`.
  Source tags/names are untrusted data, never execution instructions.

The first implementation loads spatial location cells and/or feature cells. Legacy
location archives use their whole location block; excessive size fails the budget.
Geometry and attributes share feature blocks today: projection limits **tool output**,
not the geometry bytes fetched for a feature family. Separate attribute columns,
a general spatial join planner, resumable preparation and persistent task handles
remain future work. Routing continues to use its existing progressive graph-cell
engine; query-result references are not yet direct route/isochrone inputs.

## Retention and measured address cost

New PBF imports retain explicit `addr:housenumber` records on nodes and supported
closed ways/multipolygons, plus useful unnamed POIs and their OSM tags. Semantic-only
areas survive ingestion without rendering as land. Search stores structured street,
house number, place, city, postcode and country where tagged, and address aliases.
There is no interpolation, missing-address inference, relation-based associatedStreet
resolution or authoritative administrative hierarchy. Search and extract payloads
remain independent of visual zoom. Map labels omit bulky address/tag fields.

The manifest advertises `address-search`, `semantic-locations` and versioned
`semantics` retention metadata when search is included. Older files remain readable
and do not acquire these claims. Source/compiler checkpoint identities were bumped:
new imports must use a new workspace; old semantic checkpoints must not be reused
and silently omit the new records. Existing completed archives are untouched.

On the existing Liechtenstein PBF (27 October 2026), comparing search-only archives
with identical POI coverage and with/without explicit address retention:

| Measurement | Without addresses | With addresses |
|---|---:|---:|
| Search records | 6,938 | 18,994 |
| Archive bytes | 3,851,861 | 10,122,340 |
| Index construction in this run | 1.30 s | 3.89 s |

12,571 records carry explicit addresses; increment **6,270,479 bytes (~5.98 MiB),
about 499 bytes/address**, including compressed search/index duplication. This is
one sample, not a planet projection. POI tags and future administrative data are
separate costs. Reproduce with `cargo build --release -p atlas-osm-import --bins`
and `bun run benchmark:addresses data/liechtenstein.osm.pbf`.

Validation: `bun test tests/workspace.test.ts tests/contextvm.test.ts` exercises
composition, cache-only, budgets, unknown values, conflicting overlaps and the real
ContextVM transport on an isolated local relay. `bun run verify:workspace-build`
compiles the small local PBF at z0–16 with all capabilities and tests a real address
after closing its file reader. Temporary build files are removed afterwards.

Hashtree/Nostr discovery and transport are a separate follow-up. This workspace
contract uses the existing verified byte-range reader and can accept another byte
source later; it does not claim Hashtree delivery is implemented.
