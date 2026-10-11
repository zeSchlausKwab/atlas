import geojsonvt from "geojson-vt";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { project, TILE_EXTENT, type Manifest } from "../../format/src/index";
import type { InputBlock } from "../../format/src/writer";
import { selectedCell } from "../../offline/src/geometry";
import { encodeTile } from "./tile-codec";
import { compactDisplayTile } from "./display-tile";

/** OSM coastline ways are open lines, not water areas. Supply assembled ocean
 * polygons, clipped to this package's coverage, separately from inland water.
 * Async depth-first traversal bounds memory and applies writer backpressure.
 */
export async function oceanTiles(
  data: FeatureCollection<Polygon | MultiPolygon>,
  manifest: Pick<Manifest, "bounds" | "minZoom" | "maxZoom" | "selection">,
  signal: AbortSignal,
  emit: (tile: InputBlock) => Promise<void>,
) {
  if (data.type !== "FeatureCollection" || !data.features?.length)
    throw Error("Expected a nonempty ocean polygon FeatureCollection");
  const [west, south, east, north] = manifest.bounds;
  let points = 0;
  for (const feature of data.features) {
    const g = feature.geometry;
    if (!g || !["Polygon", "MultiPolygon"].includes(g.type))
      throw Error("Ocean input must contain polygons only");
    const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const polygon of polygons)
      for (const ring of polygon) {
        if (
          ring.length < 4 ||
          ring[0]![0] !== ring.at(-1)![0] ||
          ring[0]![1] !== ring.at(-1)![1]
        )
          throw Error("Ocean polygon rings must be closed");
        for (const [lon, lat] of ring) {
          if (
            !Number.isFinite(lon) ||
            !Number.isFinite(lat) ||
            lon! < west - 1e-8 ||
            lon! > east + 1e-8 ||
            lat! < south - 1e-8 ||
            lat! > north + 1e-8
          )
            throw Error(
              "Clip ocean polygons to the archive bounds before tiling",
            );
          if (++points > 10000000)
            throw Error("Ocean input exceeds regional point budget");
        }
      }
    feature.properties = { class: 1 };
  }
  signal.throwIfAborted();
  const index = geojsonvt(data, {
    maxZoom: manifest.maxZoom,
    extent: TILE_EXTENT,
    buffer: 0,
    tolerance: TILE_EXTENT / 512,
    indexMaxZoom: 0,
    indexMaxPoints: 100000,
  });
  const internals = index as unknown as {
    tiles: Record<number, { numFeatures: number }>;
    tileCoords: unknown[];
  };
  const nw = project(west, north),
    se = project(east, south);
  const id = (z: number, x: number, y: number) => (2 ** z * y + x) * 32 + z;
  let count = 0;
  async function walk(z: number, x: number, y: number) {
    signal.throwIfAborted();
    const n = 2 ** z,
      key = id(z, x, y);
    if (
      x < Math.floor(nw[0] * n) ||
      x > Math.min(n - 1, Math.floor(se[0] * n)) ||
      y < Math.floor(nw[1] * n) ||
      y > Math.min(n - 1, Math.floor(se[1] * n)) ||
      (manifest.selection && !selectedCell(manifest.selection.polygon, z, x, y))
    ) {
      delete internals.tiles[key];
      return;
    }
    const tile = index.getTile(z, x, y);
    internals.tileCoords.length = 0;
    if (tile && z >= manifest.minZoom) {
      const bytes = compactDisplayTile(encodeTile(tile.features), z);
      const features = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
        4,
        true,
      );
      if (features) {
        await emit({
          key: `tile/water/${z}/${x}/${y}`,
          z,
          x,
          y,
          bytes,
          features,
        });
        count++;
      }
    }
    // Do not prune on simplified geometry: a coast/island can reappear at a
    // higher zoom. geojson-vt retains original source until children are split.
    if (z < manifest.maxZoom && internals.tiles[key]?.numFeatures)
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 2; dy++)
          await walk(z + 1, x * 2 + dx, y * 2 + dy);
    delete internals.tiles[key];
  }
  await walk(0, 0, 0);
  return count;
}
