# Raster MBTiles ingestion

`bun run raster:import` can ingest a local pre-tiled JPEG/PNG MBTiles database into
one independent Atlas archive. It preserves image bytes: there is no resampling,
JPEG recompression, temporary tile directory, or external tile service at runtime.
Use **Host console → Import files** (`/host#imports`) to upload MBTiles or an existing
Atlas file to the map library. The CLI is also available. Individual PNG/JPEG images
use **Place an image**, where you supply their geographic placement.

## Inspect and import

```sh
bun run raster:import --mbtiles /path/to/source.mbtiles --dry-run --format json
bun run raster:import --mbtiles /path/to/source.mbtiles \
  --id satellite --name 'Regional satellite imagery' --output data/satellite.atlas
```

Metadata supplies the name, bounds and credits. `--name`, `--bounds W,S,E,N`,
`--attribution` and `--license` can override them. Missing bounds need an explicit
rectangle. A missing licence is recorded as unknown; importing does not grant a
redistribution licence. Original metadata, including attribution HTML, is retained
as inert data. The manifest records the source filename (not its local directory)
and SHA-256 of the input file.

`--dry-run` is read-only and reports actual tile counts, payload bytes and an
approximate archive size. It checks metadata and coordinates, and samples image
dimensions; full import validates every tile's image header and dimensions.
`--max-mib` is optional for MBTiles, with no default artificial output cap. Estimates
do not reserve disk space. Source and destination coexist; budget for the resulting
archive and SQLite's temporary directory/index work.

Progress on stderr reports fingerprinting, tile copying, directory construction
and final packing with per-pass counts/percentage and an approximate ETA.
`--format json` puts machine-readable results on stdout. SIGINT/SIGTERM aborts the
import and removes partial output; the input is preserved. This import does not yet
resume individual tiles. Existing outputs are never overwritten.

## Format and compatibility

- Both a flat `tiles` table and normalized SQLite schemas exposing a `tiles` view
  work. SQLite is opened read-only with a bounded cache and disk-backed temp work.
- JPEG (8-bit baseline/extended/progressive) and PNG, 256 or 512 square pixels,
  Web Mercator, z0–18. Vector PBF, WebP and non-Mercator inputs are rejected.
- Standard MBTiles TMS rows become Atlas XYZ rows: `y = 2^z - 1 - tile_row`.
  An explicit nonstandard `scheme=xyz` is honoured and reported.
- Actual rows determine available zoom limits. Duplicate addresses, out-of-range
  coordinates, mixed encodings/sizes and invalid headers fail the import.
- A live WAL is rejected. Keep the source unchanged during ingestion; changes to
  its identity, size or timestamps invalidate the result before publication.
- Tiles are stored in paged `raster/<id>/<z>/<x>/<y>` blocks with per-block hashes.
  JPEG is advertised as `encoding: "jpeg"` and decoded with `image/jpeg`; PNG
  descriptors remain compatible. The client uses the ordinary cache/read metrics.
- All input tiles are retained, even if low-zoom tiles extend beyond metadata
  bounds. The client clips the layer to those bounds. It enlarges existing pixels
  above the maximum zoom; it does not invent resolution or elevation values.

The [MBTiles 1.3 specification](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md)
defines the SQLite table/view interface, metadata and TMS row convention.

## Serve, compose, amend

```sh
bun run build:web
ATLAS_FILE=data/satellite.atlas ATLAS_DATA_DIR=data/satellite-host \
  ATLAS_CLIENT_URL=http://127.0.0.1:5173/ HOST=127.0.0.1 PORT=3183 bun run start
```

Connect the existing client composer to `http://127.0.0.1:3183/` and add vector
catalogs as needed. The imported archive is also a normal raster donor for
`amendRasters`; only intersecting tiles are copied into a regional revision.
Routing/search identity remains that of the target map, while imagery retains its
own source fingerprint and attribution. To register a CLI-produced archive in an
already-running library, upload it using **Import files**. Check its Compose box
and another map’s box to open both in the client, or use **Manage imagery** on the
target map to embed the imported raster layer in one new file.

See [file upload API and recovery](FILE-IMPORTS.md).

## Alps rehearsal — 2026-10-29

Local input: `satellite-2017-11-02_europe_alps.mbtiles` (provided by the developer).
The filename supplies the date; the metadata does not establish imagery acquisition
dates. Source name: OpenMapTiles Satellite, description: Alps extract from
openmaptiles.com; credits: MapTiler and OpenStreetMap. No explicit licence field.

| Measure | Result |
| --- | --- |
| Original MBTiles | 610,275,328 bytes / 582.00 MiB |
| Tile payload | 577,853,049 bytes |
| Tiles | 40,223 JPEGs, 256 × 256, z0–13 |
| Bounds | 5.57178, 45.25882, 16.68994, 48.65412 |
| Finished Atlas | 579,880,495 bytes / 553.02 MiB |
| Source SHA-256 | `cc0412ecbdc82a9c734e6753b1d3c8f00270f159a1a1f2acd249c91191d9f80e` |
| Liechtenstein + satellite revision | 25,620,440 bytes / 24.43 MiB |
| Original blocks retained in that revision | 6,092, all payload hashes unchanged and readable |
| Added regional imagery | 188 tiles / 2,906,771 payload bytes |

Sample tile bytes were compared with SQLite at all 14 zoom levels after TMS
conversion. The amended file returned a walking route and eight Vaduz search
matches with both donor readers closed. The visible browser test composed satellite
and vector maps, exercised visibility/opacity, and restored cached imagery with zero
additional package requests. The initial 1540×1050 test view read about 519 KB across
both sources; it did not download the whole raster archive. No browser errors.

Tests: `bun test tests/mbtiles.test.ts tests/raster.test.ts tests/raster-amend.test.ts`.
The JPEG fixture is an original white square generated locally for tests (CC0);
the satellite imagery and generated Atlas files are ignored local data, not source assets.
