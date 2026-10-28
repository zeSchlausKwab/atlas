import type { Geometry } from "geojson";
import booleanIntersects from "@turf/boolean-intersects";
import type { AtlasReader } from "../../format/src/reader";
import {
  boxValid,
  objectId,
  overlap,
  splitBounds,
  validKey,
  type Box,
  type ObjectCatalog,
  type ObjectRecord,
  type Page,
} from "./model";
export * from "./model";
export const hasObjects = (r: AtlasReader) =>
  r.index.manifest.capabilities.includes("source-objects");
function checkedPage(p: Page) {
  if (
    !p ||
    !validKey(p.key) ||
    !/^objects\/(records|spatial|lookup|ids)\//.test(p.key) ||
    typeof p.unlocated !== "boolean" ||
    !Array.isArray(p.bounds) ||
    !p.bounds.every(boxValid) ||
    !Number.isSafeInteger(p.count) ||
    p.count < 0 ||
    !Array.isArray(p.keys) ||
    !p.keys.every((x) => typeof x === "string") ||
    !Array.isArray(p.facets) ||
    !p.facets.every((x) => typeof x === "string")
  )
    throw new Error("Invalid object index page");
  return p;
}
export async function objectCatalog(r: AtlasReader): Promise<ObjectCatalog> {
  if (!hasObjects(r))
    throw new Error(
      "This archive has no general source-object data; its display layers cannot recover omitted objects.",
    );
  const c = JSON.parse(
    new TextDecoder().decode(await r.block("objects/index")),
  );
  if (
    c?.schema !== "source-objects-v1" ||
    !Number.isSafeInteger(c.count) ||
    c.count < 0 ||
    c.report?.schema !== "retention-v1"
  )
    throw new Error("Invalid object catalog");
  checkedPage(c.spatial);
  checkedPage(c.lookup);
  if (c.spatial.count !== c.count || c.lookup.count !== c.count)
    throw new Error("Object catalog count mismatch");
  return c;
}
async function page(r: AtlasReader, p: Page, signal?: AbortSignal) {
  signal?.throwIfAborted();
  checkedPage(p);
  const b = await r.block(p.key);
  signal?.throwIfAborted();
  if (b.length > 4 * 1024 ** 2)
    throw new Error("Object index page exceeds 4 MiB");
  const v = JSON.parse(new TextDecoder().decode(b));
  if (
    !Array.isArray(v.rows) ||
    v.schema !== `objects-${p.key.split("/")[1]}-v1` ||
    v.rows.length > 256
  )
    throw new Error("Invalid object page");
  return v;
}
function validateRecord(v: ObjectRecord): ObjectRecord {
  const blob = (b: any, kind: string) =>
    !b ||
    (Array.isArray(b.blocks) &&
      b.blocks.length === Math.ceil(b.bytes / 1024 ** 2) &&
      b.blocks.every(
        (k: any) => validKey(k) && k.startsWith(`objects/${kind}/`),
      ) &&
      Number.isSafeInteger(b.bytes) &&
      b.bytes > 0 &&
      b.bytes <= 768 * 1024 ** 2);
  if (
    !v ||
    !objectId(v.id) ||
    typeof v.name !== "string" ||
    !v.tags ||
    Array.isArray(v.tags) ||
    Object.values(v.tags).some((x) => typeof x !== "string") ||
    !Array.isArray(v.bounds) ||
    !v.bounds.every(boxValid) ||
    !Array.isArray(v.facets) ||
    !v.facets.every((x) => typeof x === "string") ||
    ![
      "complete",
      "missing-nodes",
      "incomplete-area",
      "relation-members",
    ].includes(v.geometryStatus) ||
    typeof v.dependencyOnly !== "boolean" ||
    !blob(v.geometry, "geometry") ||
    !blob(v.topology, "topology")
  )
    throw new Error("Invalid object metadata");
  return v;
}
export interface ObjectQuery {
  bounds?: Box;
  facet?: string;
  tag?: { key: string; value?: string };
  text?: string;
  includeDependencies?: boolean;
  includeUnlocated?: boolean;
}
export async function* objectRecords(
  r: AtlasReader,
  q: ObjectQuery = {},
  signal?: AbortSignal,
  progress: (s: string) => void = () => {},
  onPage: (key: string) => Promise<void> = async () => {},
) {
  await onPage("objects/index");
  const root = await objectCatalog(r),
    windows = q.bounds ? splitBounds(q.bounds) : undefined;
  let pages = 0;
  const seen = new Set<string>();
  const visit = async function* (p: Page): AsyncGenerator<ObjectRecord> {
    signal?.throwIfAborted();
    checkedPage(p);
    if (seen.has(p.key)) throw new Error("Cyclic object index");
    seen.add(p.key);
    if (
      windows &&
      !(q.includeUnlocated && p.unlocated) &&
      !p.bounds.some((b) => windows.some((w) => overlap(w, b)))
    )
      return;
    if (q.tag && !p.keys.includes(q.tag.key)) return;
    if (q.facet && !p.facets.includes(q.facet)) return;
    await onPage(p.key);
    const v = await page(r, p, signal);
    progress(`Reading source objects · ${++pages} index/attribute pages`);
    if (v.schema === "objects-spatial-v1") {
      for (const child of v.rows) yield* visit(child);
      return;
    }
    if (v.schema !== "objects-records-v1")
      throw new Error("Unexpected object spatial page");
    for (const input of v.rows) {
      const row = validateRecord(input);
      if (!q.includeDependencies && row.dependencyOnly) continue;
      if (
        windows &&
        !(q.includeUnlocated && !row.bounds.length) &&
        !row.bounds.some((b) => windows.some((w) => overlap(w, b)))
      )
        continue;
      if (q.facet && !row.facets.includes(q.facet)) continue;
      if (
        q.tag &&
        (!Object.hasOwn(row.tags, q.tag.key) ||
          (q.tag.value !== undefined && row.tags[q.tag.key] !== q.tag.value))
      )
        continue;
      if (q.text) {
        const text = Object.entries(row.tags)
          .filter(
            ([k]) =>
              k.includes("name") ||
              ["ref", "wikidata", "ISO3166-1", "ISO3166-1:alpha2"].includes(k),
          )
          .map(([, v]) => v)
          .join(" ")
          .normalize("NFKD")
          .toLowerCase();
        if (
          !q.text
            .normalize("NFKD")
            .toLowerCase()
            .split(/\s+/)
            .every((t) => text.includes(t))
        )
          continue;
      }
      yield row;
    }
  };
  yield* visit(root.spatial);
}
export async function findObject(
  r: AtlasReader,
  id: string,
  signal?: AbortSignal,
): Promise<ObjectRecord | undefined> {
  if (!objectId(id)) throw new Error("Use an exact OSM object identity");
  const c = await objectCatalog(r);
  const seen = new Set<string>();
  const visit = async (p: Page): Promise<ObjectRecord | undefined> => {
    if ((p.min && id < p.min) || (p.max && id > p.max)) return;
    if (seen.has(p.key)) throw new Error("Cyclic object ID index");
    seen.add(p.key);
    const v = await page(r, p, signal);
    if (v.schema === "objects-lookup-v1") {
      for (const child of v.rows) {
        const found = await visit(child);
        if (found) return found;
      }
      return;
    }
    if (v.schema !== "objects-ids-v1")
      throw new Error("Unexpected object ID index");
    const hit = v.rows.find((x: any) => x.id === id);
    if (!hit) return;
    if (!validKey(hit.page) || !hit.page.startsWith("objects/records/"))
      throw new Error("Invalid object record pointer");
    const records = JSON.parse(
      new TextDecoder().decode(await r.block(hit.page)),
    );
    if (records.schema !== "objects-records-v1" || !Array.isArray(records.rows))
      throw new Error("Invalid object record page");
    const found = records.rows.find((x: any) => x.id === id);
    if (!found) throw new Error("Object index identity mismatch");
    return validateRecord(found);
  };
  return visit(c.lookup);
}
async function blob(
  r: AtlasReader,
  ref: NonNullable<ObjectRecord["geometry"]>,
  signal?: AbortSignal,
) {
  const output = new Uint8Array(ref.bytes);
  let at = 0;
  for (const key of ref.blocks) {
    signal?.throwIfAborted();
    const b = await r.block(key);
    if (b.length > 1024 ** 2 || at + b.length > output.length)
      throw new Error("Invalid object payload size");
    output.set(b, at);
    at += b.length;
  }
  if (at !== output.length) throw new Error("Incomplete object payload");
  return JSON.parse(new TextDecoder().decode(output));
}
export async function objectGeometry(
  r: AtlasReader,
  row: ObjectRecord,
  signal?: AbortSignal,
): Promise<Geometry | undefined> {
  validateRecord(row);
  if (!row.geometry) return;
  const g: Geometry = await blob(r, row.geometry, signal);
  const { geometryBounds } = await import("./model");
  if (JSON.stringify(geometryBounds(g)) !== JSON.stringify(row.bounds))
    throw new Error("Object geometry extent mismatch");
  return g;
}
export async function objectTopology(
  r: AtlasReader,
  row: ObjectRecord,
  signal?: AbortSignal,
) {
  validateRecord(row);
  return row.topology ? blob(r, row.topology, signal) : {};
}
/** Dateline-aware local planar intersection. Storage supports poles; polar cap polygon interpretation is not inferred. */
export function intersectsGlobal(g: Geometry, bounds: Box) {
  const unwrap = (v: Geometry): Geometry => {
    const line = (ps: number[][], anchor?: number) => {
      let prev = anchor ?? ps[0]![0]!;
      return ps.map((p) => {
        let x = p[0]!;
        while (x - prev > 180) x -= 360;
        while (x - prev < -180) x += 360;
        prev = x;
        return [x, p[1]!];
      });
    };
    switch (v.type) {
      case "Point":
      case "MultiPoint":
        return v;
      case "LineString":
        return { ...v, coordinates: line(v.coordinates) };
      case "MultiLineString":
        return { ...v, coordinates: v.coordinates.map((p) => line(p)) };
      case "Polygon":
        return {
          ...v,
          coordinates: v.coordinates.map((p) =>
            line(p, v.coordinates[0]![0]![0]),
          ),
        };
      case "MultiPolygon":
        return {
          ...v,
          coordinates: v.coordinates.map((poly) =>
            poly.map((p) => line(p, poly[0]![0]![0])),
          ),
        };
      case "GeometryCollection":
        return { ...v, geometries: v.geometries.map(unwrap) };
    }
  };
  const u = unwrap(g);
  return splitBounds(bounds).some((b) =>
    [-360, 0, 360].some((d) =>
      booleanIntersects(u, {
        type: "Polygon",
        coordinates: [
          [
            [b[0] + d, b[1]],
            [b[2] + d, b[1]],
            [b[2] + d, b[3]],
            [b[0] + d, b[3]],
            [b[0] + d, b[1]],
          ],
        ],
      }),
    ),
  );
}
export async function* readObjects(
  r: AtlasReader,
  bounds: Box,
  geometry = true,
  signal?: AbortSignal,
  predicate: (f: any) => boolean = () => true,
  progress?: (s: string) => void,
  q: ObjectQuery = {},
) {
  for await (const row of objectRecords(
    r,
    { ...q, bounds },
    signal,
    progress,
  )) {
    const f = {
      type: "Feature" as const,
      id: row.id,
      bbox: row.bounds[0],
      properties: {
        id: row.id,
        name: row.name,
        kind: "objects" as const,
        tags: row.tags,
        facets: row.facets,
        geometryStatus: row.geometryStatus,
      },
    };
    if (!predicate(f) || !row.geometry) continue;
    const contained = row.bounds.every((b) =>
      splitBounds(bounds).some(
        (w) => w[0] <= b[0] && w[1] <= b[1] && w[2] >= b[2] && w[3] >= b[3],
      ),
    );
    const g =
      geometry || !contained ? await objectGeometry(r, row, signal) : undefined;
    if (g && !intersectsGlobal(g, bounds)) continue;
    yield { ...f, ...(geometry ? { geometry: g! } : {}) };
  }
}
