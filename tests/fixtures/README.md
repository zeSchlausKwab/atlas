# Building regression fixture

`sechshauser-60.osm.pbf` contains OSM relation 2342301 (Sechshauser Straße 60, Vienna), its outer/inner ways, and referenced nodes. Extracted from the 2026-10-06 Geofabrik Austria source with `osmium getid ... r2342301 -r`. The original importer emitted zero features for this valid building. The regression requires its footprint and courtyard to survive import.

© OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright
