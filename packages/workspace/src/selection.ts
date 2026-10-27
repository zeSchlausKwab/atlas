import type { AtlasReader } from "../../format/src/reader";
import { project } from "../../format/src/index";
import { decodePlaces, encodePlaces } from "../../labels/src/places";
import { STREET_ZOOM } from "../../geocoding/src/paging";
import type { Bounds } from "../../features/src/index";
import type { Filter } from "./index";

/** The partitioned compiler's paged overview contains every retained place=city
 * anchor, not a zoom-dependent sample. Its excerpts retain all city/town/village
 * anchors in inline labels. Unknown producers fall back to the exact spatial scan.
 * The labels select cells, never provide attributes or replace source identities.
 */
export async function cityCandidateCells(
  reader: AtlasReader,
  bounds: Bounds,
  where: Filter[],
) {
  const eq = (field: string, value: string) =>
    where.some((f) => f.field === field && f.op === "eq" && f.value === value);
  const m = reader.index.manifest;
  if (
    !eq("kind", "place") ||
    !(eq("category", "city") || eq("tags.place", "city")) ||
    !m.source.extraction?.strategy.includes("partitioned-build-v1") ||
    !reader.index.blocks.some((b) => b.key === "labels/places")
  )
    return;
  const bytes = await reader.block("labels/places");
  const root = JSON.parse(new TextDecoder().decode(bytes));
  const places =
    root.schema === "places-paged-v1" && root.zoom === 8
      ? decodePlaces(encodePlaces(root.overview))
      : root.schema === "places-v1" && m.selection
        ? decodePlaces(bytes)
        : undefined;
  if (!places) return;
  const n = 2 ** STREET_ZOOM;
  return [
    ...new Set(
      places
        .filter(
          (p) =>
            p.coordinates[0] >= bounds[0] &&
            p.coordinates[0] <= bounds[2] &&
            p.coordinates[1] >= bounds[1] &&
            p.coordinates[1] <= bounds[3],
        )
        .map((p) => {
          const [x, y] = project(...p.coordinates);
          return `search/locations-data/${STREET_ZOOM}/${Math.floor(x * n)}/${Math.floor(y * n)}`;
        }),
    ),
  ];
}
