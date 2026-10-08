# Building regression fixture

`sechshauser-60.osm.pbf` contains OSM relation 2342301 (Sechshauser Straße 60, Vienna), its outer/inner ways, and referenced nodes. Extracted from the 2026-10-06 Geofabrik Austria source with `osmium getid ... r2342301 -r`. The original importer emitted zero features for this valid building. The regression requires its footprint and courtyard to survive import.

© OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright

## Danube with a nested island

`danube-2742635.osm.pbf` contains OSM relation 2742635, the nested sand-island relation 21495386, and all referenced ways/nodes. Extracted recursively from the cached Vienna Plus source with `osmium getid ... r2742635 -r`. The old importer rejected the nested inner relation and dropped the entire river. The regression checks water at 16.34° E / 48.31° N and preserves the sand island as a hole. Same OSM attribution and license as above.
