import { project } from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import { bounds, inside, type Polygon } from "../../offline/src/geometry";
import { locations, streets } from "./index";
import { STREET_ZOOM } from "./paging";
import type { LocationBlock, StreetBlock, Location, Street } from "./model";
/** Geographic source pages allow excerpts without scanning the global text index. */
export async function selectedSearch(
  reader: AtlasReader,
  polygon: Polygon,
  kind: "locations",
): Promise<LocationBlock>;
export async function selectedSearch(
  reader: AtlasReader,
  polygon: Polygon,
  kind: "streets",
): Promise<StreetBlock>;
export async function selectedSearch(
  reader: AtlasReader,
  polygon: Polygon,
  kind: "locations" | "streets",
): Promise<LocationBlock | StreetBlock> {
  const box = bounds(polygon),
    a = project(box[0], box[3]),
    b = project(box[2], box[1]),
    n = 2 ** STREET_ZOOM;
  const blocks = await reader.spatial(
    `search/${kind}-data`,
    STREET_ZOOM,
    Math.max(0, Math.floor(a[0] * n)),
    Math.min(n - 1, Math.floor(b[0] * n)),
    Math.max(0, Math.floor(a[1] * n)),
    Math.min(n - 1, Math.floor(b[1] * n)),
  );
  const records: Location[] = [],
    roads: Street[] = [],
    seen = new Set<string>();
  let read = 0;
  for (const block of blocks) {
    const bytes = await reader.block(block.key);
    read += bytes.length;
    if (read > 64 * 1024 * 1024)
      throw new Error(
        "Search excerpt exceeds the 64 MiB selection budget. Choose a smaller area.",
      );
    if (kind === "locations")
      for (const { record } of locations(bytes)) {
        if (inside(record.coordinates, polygon)) records.push(record);
      }
    else
      for (const { street } of streets(bytes)) {
        const identity = street.id + JSON.stringify(street.coordinates);
        if (!seen.has(identity)) {
          seen.add(identity);
          roads.push(street);
        }
      }
    reader.cache.delete(block.key);
  }
  return kind === "locations"
    ? { schema: "locations-v1", records }
    : { schema: "streets-v1", streets: roads };
}
