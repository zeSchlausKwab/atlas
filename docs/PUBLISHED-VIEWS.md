# Publisher views and client overrides

A view is a recommendation over immutable map data. A host can publish several views of the same Atlas files without rewriting, copying or rehashing their payloads. The first implementation is independent of the archive codec and works with already-published maps.

## Host

Open **Library → Published views → Create or edit a view**. Select published Hashtree sources in display priority order, choose an appearance, geometry and label visibility, optional imagery, and the tools available on demand. **Publish view** signs and persists a new recipe revision. Marking it the host default applies it to new client sessions without an explicit map selection or shared view. Editing an existing recipe preserves its identity; unchecking the default box removes that designation if this was the default.

The first editor offers the existing Paper, Midnight and Blueprint palettes, fits the selected sources on opening, and uses a single label toggle and imagery opacity of 60%. The API supports the full validated paint document, separate label categories, per-source imagery toggles/opacity, and a starting camera. The client exposes the detailed paint controls. Editing an existing recipe preserves custom paint, scene, camera, per-source choices and imagery opacity unless their corresponding control is changed.

Only maps already published on this host can be selected in this editor. The client can discover and combine additional publishers. Publication validates the source URL/root and available geometry families. Recipe capabilities do not manufacture data missing from an archive.

## Client

**Map** brings the former Composer, Data and Style tabs together:

- **Sources:** publishers, pinned map revisions, source order, per-source display subscriptions, imagery and coverage inspection.
- **Layers & data:** display choices across all sources; independent on-demand routing, search, query and feature-analysis permissions; a link to saved areas.
- **Appearance:** paint presets, colors, widths, label paint and supported scene settings.

Old `#tab=composer`, `#tab=data` and `#tab=style` links still open the corresponding section. Changing a display layer controls its display reads; it does not change permission to analyze those objects. Turning an on-demand tool on does not preload its data. Hiding a layer never deletes cached blocks. Offline acquisition remains an explicit area/capability operation; its coverage must be inspected separately from display visibility.

The **Published view** picker offers the host's signed recipes and recipes discovered from explicitly selected Nostr publishers. New announcements never replace the active view. **Reset to publisher defaults** returns to the exact selected recipe revision; **Copy view link** preserves source roots, priority, all paint settings, data choices, camera and the signed baseline. A fresh browser reproduces the view instead of substituting that browser's old appearance preferences. Explicit `?maps=` selections keep their selected sources and do not automatically adopt the host default.

Precedence is shared-view overrides → explicitly selected publisher recipe → host default → existing client preferences. Settings changes are captured in the URL without navigation. Opening a different server clears a stale `viewRecipe` parameter. Missing pinned map roots produce an availability message, never a silent upgrade to different data. A view link requires its source announcements/data to remain available; it is not an offline map package.

## Contract and API

`packages/views/src/index.ts` validates a version-1 recipe:

- `id`, `name`, and ordered `sources` with HTTP URL, exact Hashtree `root`, `enabled`, `layers`, `labels`, and per-layer imagery state.
- `presentation`: validated semantic `style`, `scene`, global display `layers`, separate place/street/POI labels, and a list of allowed on-demand tool purposes.
- Optional starting `camera`, plus `coverage` outline preference.

Recipes contain no executable scripts, inferred bulk-download permission or embedded credentials. Style-only changes use the renderer's existing uniform update path.

The application-specific Nostr kind **30065** uses `d=atlas-view/<id>`, `t=atlas-view`, and source `hash` tags. Its event ID pins the recipe revision; map roots pin the independent Hashtree data. Signature verification and recipe validation precede application. Unlike expiring discovery offers, pinned view revisions do not expire automatically. A signature identifies the publisher; it does not make an arbitrary newly discovered publisher trusted.

- `GET /views`: publisher identity, current recipe events and default recipe ID.
- `GET /views/<event-id>`: immutable signed revision, including superseded revisions.
- `GET /admin/views`: current recipes plus published source offers for the editor.
- `POST /admin/views`: `{recipe, makeDefault}`; same-origin authorized administration. Writes are serialized and atomically persisted in `hashtree/views.json`.
- `/discovery` includes current recipe events. The host's Nostr relay serves them; the browser's existing publisher subscriptions can discover them alongside map offers.

Public reads support the separate client origin. Administration does not acquire public CORS access. Current limits follow the existing eight-active-map client and add at most 100 named host recipes. Old revisions are retained for reproducible links.

## Evidence and next steps

Contract tests cover independent revisions with unchanged Atlas bytes/roots, restart, old-link retrieval, invalid roots, signature tampering, cross-origin reads, same-origin writes, and real Nostr relay delivery. A visible browser rehearsal covers publisher-first loading, independent display/tool settings, paint changes with zero additional Hashtree requests, fresh-browser sharing, reset and responsive layout.

Still separate work: field-expression styles with declared attribute dependencies; publishing third-party sources directly from the host view editor; embedding the recipe/assets in a portable Atlas export; portable browser exports and completely disconnected application startup. This slice does not change routing compatibility or establish continental performance. The existing host acquisition flow still creates self-contained data archives, and saved browser areas remain persistent source-block caches.
