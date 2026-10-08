# Location search and nearest-street demo

The same `.atlas` package now answers two local queries:

- Text → a representative location for a named place, street, POI or peak.
- Coordinate → the nearest retained street segment within 1 km, its name/type, nearest point, and straight-line distance.

No external geocoding endpoint, API key or routing server is used. Both operations work with HTTP range data, a local file, or cached blocks. This slice deliberately stops short of full address geocoding.

## Try it

1. Search `Vaduz`, `Landstrasse Vaduz`, or `Städtle`; choose a result to move the map.
2. Under Coordinates → nearest street, enter `47.13929, 9.52280` (**latitude, longitude**). The pinned sample finds **Städtle**, about **16 m** away. The blue line is the selected OSM way; the dotted connector is straight-line offset, not a route.
3. Choose Pick on map and click a point. Pan/zoom while selecting; Enter chooses the center, Escape cancels. Switching to routing selection cancels coordinate selection and vice versa.
4. Use Route from here / Route to here to pass the selected result to the walking demo. Routing still applies its own graph and 150 m snapping policy.
5. Enable Cache only before a first search or reverse lookup to see the missing-data error. After each block has loaded once, its operation can run without additional reads. This toggle uses a session cache. The separate drawn-area export saves a local package, and the service worker caches the app shell for offline reloads.

The map camera reaches zoom 20 by overzooming the existing highest-detail vector tiles. A package with tiles through z14 still contains exactly those zoom levels; zooming closer does not invent missing data.

## Source compilation

The Rust importer retains named OSM nodes with place, amenity, tourism, shop, historic, public_transport or natural tags. These are search records only; they do not all gain new display symbols. Places and peaks receive separate record kinds.

The Bun compiler derives named street and named POI/building records from retained display ways, and writes two independently addressed blocks:

| Block              |   Sample count | Sample bytes | Purpose                                                                                |
| ------------------ | -------------: | -----------: | -------------------------------------------------------------------------------------- |
| `search/locations` |  3,104 records |      509,668 | Name, alias, kind, category, representative location and optional nearby-place context |
| `search/streets`   | 7,696 OSM ways |    2,512,099 | Named and unnamed street geometry for reverse lookup                                   |

Aliases include alt_name, short_name, name:de and name:en where present. Semicolon-separated values are split. Repeated street-name fragments are grouped by normalized name and nearest retained city/town/village/hamlet within 10 km. Their representative is a source-segment point nearest that settlement center. This grouping is a demo heuristic: context says “near”, not “inside”. It can split a long road or group disconnected same-name ways near a settlement.

Named building/POI ways use an original boundary vertex as a representative point; it is not an inferred entrance. Multipolygon relations, address-only nodes, house numbers, interpolated addresses and administrative boundaries are not compiled. Retained street types and wire records are specified in [FORMAT.md](FORMAT.md).

## Consumer API

```ts
import { AtlasGeocoder } from "./packages/geocoding/src/index";

const geocoder = new AtlasGeocoder(reader); // an opened AtlasReader
const places = await geocoder.search("Landstrasse Vaduz");
const street = await geocoder.reverse([9.5228, 47.13929]); // [lon, lat]
```

All library coordinates use `[longitude, latitude]`; the labelled demo input accepts `latitude, longitude`. Results contain the reader's snapshot, source-extract scope, and whether the operation's block was already cached. `search` defaults to eight matches and accepts a limit of 1–30. Empty/too-short queries and invalid coordinates fail before reading data.

Forward search normalizes case, Unicode combining marks, punctuation, whitespace, and ß → ss. It ranks exact name/alias matches, prefixes, word prefixes, substrings, then matches using nearby-place context. It does not correct typos or infer alternate spellings beyond recorded aliases and the documented normalization. No house-number parsing or postal-address claim is made.

Reverse lookup prefilters ways with coordinate bounding boxes, projects onto individual segments in a local planar metric, then measures spherical distance. It returns the closest retained way within 1,000 m. A nearby unnamed street remains unnamed; it is never replaced by a farther named street just to produce a label. This is geographic proximity, independent of foot access, barriers or routing connectivity.

## Limits and next experiments

This implementation parses two independently compressed JSON blocks into memory and runs synchronous TypeScript queries. It scans normalized name records and street bounding boxes; it has no persisted text index, paged spatial tree, worker, or Rust/WASM geocoder yet. Rendering and walking-route computation continue to use Rust/WASM.

Results cover retained data in this regional extract. A no-match result is not proof that the location or a closer street does not exist elsewhere. Dateline-spanning extracts are not supported; coordinates are limited to ±85° latitude. Segment projection is a regional approximation rather than ellipsoidal survey-grade geometry.

Next steps can add address points and hierarchy, language-aware normalization, candidate deduplication beyond the current heuristic, paged text/spatial indexes, persistent caches and worker/WASM query execution. These can keep the existing ByteSource/AtlasReader boundary.

Tests cover named-fragment compilation, stable output, aliases/accent/context ranking, nearest-segment versus nearest-vertex behavior, unnamed roads, 1 km misses, coordinate order/validation, independent offline caches, concurrent loads and corruption. Visible-browser checks cover zoom 20, results/markers, coordinate/map input, routing handoff, local-file use and mobile layout.
