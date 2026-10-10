import { project, type Place } from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import { bounds, inside, type Polygon } from "../../offline/src/geometry";
import { decodePlaces, encodePlaces, PLACE_LABEL_KEY } from "./places";
export const PLACE_PAGE_ZOOM = 8;
export async function placesInView(
  reader: AtlasReader,
  world: [number, number, number, number],
  zoom: number,
) {
  const bytes = await reader.block(PLACE_LABEL_KEY),
    root = JSON.parse(new TextDecoder().decode(bytes));
  if (root.schema !== "places-paged-v1") return decodePlaces(bytes);
  if (root.zoom !== PLACE_PAGE_ZOOM)
    throw new Error("Invalid settlement page grid");
  if (zoom < 8) return decodePlaces(encodePlaces(root.overview));
  const n = 2 ** PLACE_PAGE_ZOOM,
    values: Place[] = [];
  const blocks = await reader.spatial(
    "labels/settlements",
    PLACE_PAGE_ZOOM,
    Math.max(0, Math.floor(world[0] * n)),
    Math.min(n - 1, Math.floor(world[2] * n)),
    Math.max(0, Math.floor(world[1] * n)),
    Math.min(n - 1, Math.floor(world[3] * n)),
  );
  if (blocks.length > 256) throw new Error("Settlement viewport is too large");
  for (const b of blocks)
    values.push(...decodePlaces(await reader.block(b.key)));
  return values;
}
export async function selectedPlaces(reader: AtlasReader, polygon: Polygon) {
  const b = bounds(polygon),
    nw = project(b[0], b[3]),
    se = project(b[2], b[1]);
  return (await placesInView(reader, [...nw, ...se], 8)).filter((p) =>
    inside(p.coordinates, polygon),
  );
}
/** Small view controller shared by standalone and composed renderers. */
export class PlacesView {
  values: Place[] = [];
  loading = false;
  private signature = "";
  private dead = false;
  constructor(
    readonly reader: AtlasReader,
    readonly invalidate: () => void,
    readonly error: (message: string) => void,
  ) {}
  update(world: [number, number, number, number], zoom: number) {
    if (!this.reader.index.blocks.some((b) => b.key === PLACE_LABEL_KEY))
      return this.reader.index.manifest.places;
    const sig =
      zoom < 8
        ? "overview"
        : world.map((v) => Math.floor(v * 2 ** PLACE_PAGE_ZOOM)).join(",");
    if (!this.loading && sig !== this.signature) {
      this.signature = sig;
      this.loading = true;
      void placesInView(this.reader, world, zoom)
        .then((p) => {
          if (!this.dead) this.values = p;
        })
        .catch((e) => {
          if (!this.dead) this.error(String(e));
        })
        .finally(() => {
          this.loading = false;
          if (!this.dead) this.invalidate();
        });
    }
    return this.values;
  }
  retry() {
    this.signature = "";
  }
  destroy() {
    this.dead = true;
  }
}
