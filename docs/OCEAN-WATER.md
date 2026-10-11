# Ocean water

The PBF importer recognizes inland `natural=water`, reservoirs and riverbank
areas. `natural=coastline` ways are open, directed boundary segments; treating
individual segments as polygons would flood land or leave gaps. The first Britain
build therefore had lakes and rivers, but no sea polygons. This was unrelated to
the low-zoom tiny-polygon filter.

The ocean step consumes assembled polygons from
[OSM water polygons](https://osmdata.openstreetmap.de/data/water-polygons.html).
They come from OSM coastlines and exclude inland lakes and reservoirs. They are
ODbL data and retain the existing OpenStreetMap attribution. For a strict shared
snapshot, assemble coastlines globally from the same planet PBF with osmcoastline;
a cropped PBF does not in general contain complete coastline rings.

## Add ocean to an existing package

1. Cache and fingerprint the provider's `water-polygons-split-4326.zip` (the
   existing `fetchSource` helper writes `{url,bytes,sha256}` to `.source.json`).
2. Clip the shapefile to the map's bounds with GDAL. For a polygon selection,
   use that polygon as the clip source. Coordinates must be EPSG:4326.
3. Run the bounded regional water step:

```sh
ogr2ogr -f GeoJSON ocean.geojson \
  /vsizip/ABSOLUTE/water-polygons-split-4326.zip/water-polygons-split-4326/water_polygons.shp \
  -spat WEST SOUTH EAST NORTH -clipsrc WEST SOUTH EAST NORTH \
  -makevalid -t_srs EPSG:4326

bun scripts/add-ocean.ts original.atlas ocean.geojson with-ocean.atlas water-polygons-split-4326.zip.source.json
```

The output must be a new path. The original archive remains untouched. SIGINT or
SIGTERM removes this command's partial output and temporary SQLite index. A hard
kill can leave `.part` / `.patch-*` scratch files; choose a fresh output path or
remove those explicitly after checking no writer remains. This incremental step
is restartable from the original file, not checkpoint-resumable.

This version is a regional post-processing CLI, not yet a host-UI build option.
It accepts up to 256 MiB / 10 million points of clipped GeoJSON and a 32 GiB output.
It writes the archive's full configured zoom range. It must not be used directly
on the uncut global shapefile. The core PBF importer still needs this ocean step
for newly built coastal regions; inland-only excerpts need no additional source.

## Archive and reader behavior

- No new file-format version, client fallback, runtime basemap or renderer is
  required. Ocean polygons use normal `tile/water/z/x/y` records.
- New ocean records merge with existing inland water. Island holes and winding
  are retained. The Water toggle controls the whole layer and its requests.
- Existing non-water payloads and directory-leaf hashes remain unchanged. The
  original data region is copied once; replaced water payloads become unreferenced
  bytes. This deliberately trades a little disk space for a narrow, safe repair.
- SQLite tracks changed water entries on disk. Depth-first tiling releases
  geojson-vt descendants and awaits writes instead of queuing millions of tiles.
- The archive gets a new snapshot, but its transport graph identity is preserved.
  The manifest records both the coastline source hash and clipped-input hash.
  Separately dated coastlines are explicitly distinguished from the PBF snapshot.
- Ocean additions currently affect display geometry only. Extractable source
  features still describe the original PBF; this does not introduce an ocean
  GeoJSON query or make water routable.

Validate the new archive before publishing it. For Britain:

```sh
bun scripts/verify-britain-water.ts with-ocean.atlas original.atlas
```

The probe checks North Sea / Irish Sea / Hebrides water, London and island land,
and an inland lake at multiple zooms. With the original path it also compares all
non-water directory hashes, capabilities, graph identity, and a streaming SHA-256
of the entire original data region. Then replace the hosted file atomically,
update its preparation record, and restart the server to close pinned readers.
Keep the previous file and record for rollback. Consumers must reopen the map
(or refresh) to use the new snapshot; old cached blocks are never mixed with it.

## Follow-up performance work

Uniform sea tiles contain only a few coordinates, but still have an entry for
every covered tile. A future format can represent uniform coverage or share
payloads. This repair intentionally uses today's fully supported layout. Measure
root-directory transfer separately from water geometry when evaluating it.
