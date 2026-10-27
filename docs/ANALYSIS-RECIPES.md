# Reusable client analysis recipes

The AI can now define an analysis once, expose its numeric parameters as sliders,
and rerun it locally without another model request. This uses existing cached Atlas
results. It requires no new map build, server deployment, or archive format change.

## Tools

- `result_rows`: normalized paged inspection for both workspace and derived results.
  Location records become Points; geometry stays local. The old `workspace_result`
  still works and now also accepts derived geometry references.
- `result_merge`: combine cached geometry and deduplicate identical source IDs.
  Conflicting copies fail. Prefer preparing compatible chunks in one workspace
  rather than manually splitting and merging them.
- `result_style`: numeric thresholds, explicit categories, a palette, optional labels,
  and counted legends. Missing/non-numeric values have their own color. `map_draw`
  inherits this style and legend. No code generation is needed just to color data.
- `spatial_bands.excludeResult`: separate polygon mask subtracted from every band.
  `excludeSource` removes only selected source interiors; use an all-water mask to
  exclude neighboring channels/lakes as well. Lines cannot be exclusion masks.
- `result_check`: polygon structure, area, optional pairwise overlap, excluded-mask
  overlap, and area beyond clip bounds. Requested checks report measurements and
  a `passed` flag. Unrequested checks are null; empty output is explicit. These do
  not establish completeness, hydraulic risk, or full topological validity.
- `recipe_define` / `recipe_run`: named ordered native operations over cached inputs.

## Recipe contract

A recipe has `title`, `parameters`, ordered `steps`, and an `output` step ID.
Each numeric parameter declares `value`, `min`, `max`, optional `step`, `label`
and `unit`. Step arguments can contain exact strings `$param.NAME` or `$step.ID`.
The latter resolves to that previous step's geometry/field reference. Forward
references, missing parameters, duplicate IDs and unsupported operations fail.
Resolved arguments are checked against the same native tool schemas as normal calls.

Allowed steps are native geometry operations, result filtering/merging/styling/checks,
and field creation/contouring. No code execution, source downloads, or UI mutations
run inside the recipe. `recipe_run` returns per-step timings, counts, reuse and checks.
Failed checks prevent publication. The previous drawing survives cancellation/failure;
a successful rerun replaces it. The final result must be geometry.

Each successful step is cached by operation and fully resolved arguments. Changing
one parameter recomputes its dependents while unrelated steps reuse their results.
An identical rerun reuses every step. Sliders have an explicit **Rerun analysis**
button to avoid starting costly work on every pointer movement. **Stop analysis**
cancels between geometry operations; an individual synchronous geometry kernel
cannot be interrupted mid-call. Live progress and elapsed time remain visible.

Recipes, cached variants and geometry live for the chat session. Export JSON contains
recipe definitions, current parameters and run history, as well as the existing tool
traces and drawings. It is a development record, not a portable replay bundle: opaque
source references need preparation again after a reload. New chat clears recipes.

For footprint suitability, buffer individual target features and spatially filter
buildings against them. Avoid dissolving a whole railway network solely to test
intersections. Filters retain complete features and include boundary touching;
they do not measure walking access. Prepare padded bounds and state missing boundary
coverage. Choose rail classes deliberately; tracks, tramways, platforms and disused
ways do not mean the same thing.

## Telemetry

Collapsed running tool cards show progress plus a live human-readable duration.
Arguments and response details remain collapsible. The composition's memory meter
also works before a tool source is selected.

“Package bytes this session” includes completed AI worker source transfers and map
reads, with purpose breakdowns and `AI ·` recent-read entries. Failed requests and
cache hits add no bytes. Routing already reads through the shared map readers and is
not added a second time. New chat does not reset the page's transfer total. Reopening
a map composition starts its new accounting session. This measures bytes read from
package sources, not LLM traffic, decoded memory or unique-byte coverage.

## Verification

`bun run verify:recipes-pair` runs an adjustable parks/railways/tram-stop analysis
against the local two-chunk Vienna rehearsal. On the development machine:

- Rectangle `[16.30,48.16,16.46,48.26]`, one combined workspace.
- 101,834 retained buildings, 733 park polygons, 7,880 railway features and 778 tram stops.
- Initial source reads: 32,121,054 bytes; preparation ~6.2 seconds.
- First native recipe run ~71 seconds, zero further map reads, 44,001 selected buildings.
- Identical rerun reused all 7 steps (under 1 ms in the data engine; drawing still has a cost).
- Changing park distance from 400 to 500 m reused the rail and tram buffers, recomputed
  dependent filters in ~72 seconds, and selected 45,757 buildings with zero reads.

This is a reproducible geometry workload, not an apples-to-apples benchmark against
the uploaded AI conversation (its selected building sets differed). It intentionally
includes all retained rail classes and has no sources outside the rehearsal extent.
Those selections are suitable for engine testing, not a claim about practical access.

A visible browser rehearsal verifies exclusion checks, always-visible tool progress,
shared transfer totals, slider reruns with no model calls/source reads, replacement
rather than duplicate drawings, JSON export and new-chat cleanup. Unit tests cover
mask differences, clipping/disjointness, unknown colors, duplicate IDs, caching,
invalid recipes, cancellation, failed checks and atomic drawing replacement.
