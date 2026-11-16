import { mkdtemp, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TILE_EXTENT } from "../../format/src/index";
import { tileRecords } from "../../format/src/tiles";
import { runCompiler } from "../../provisioning/src/process";
import { encodeTile } from "./tile-codec";
import type geojsonvt from "geojson-vt";

type Ring = number[][];
type Polygon = Ring[];
const area = (ring: Ring) =>
  ring.reduce((n, p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return n + p[0]! * q[1]! - q[0]! * p[1]!;
  }, 0);

/** Recover coarse legacy spools without re-reading the planet or weakening the
 * tile decoder. Coordinates are tile units, not longitude/latitude: no CRS
 * transform is performed. GEOS preserves topology within each feature; shared
 * boundaries between separate features are not jointly simplified.
 */
export async function generalizePackedDisplay(
  parts: Uint8Array[],
  key: string,
  scratch: string,
  signal: AbortSignal,
  onMessage: (message: string) => void = () => {},
): Promise<Uint8Array[]> {
  signal.throwIfAborted();
  const zoom = Number(key.split("/")[2]);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom >= 13)
    throw new Error(`Tile ${key} requires finer partitioning at detail zoom`);
  if (!Bun.which("ogr2ogr"))
    throw new Error(
      `Tile ${key} needs GDAL (ogr2ogr) to generalize its saved display fragments; install GDAL and resume`,
    );
  const records = parts.flatMap((p) =>
    [...tileRecords(p)].map((r) => ({
      bytes: p.subarray(r.start, r.end),
      class: r.class,
      kind: r.kind,
      parts: r.parts,
      geometryOffset: r.geometryOffset - r.start,
    })),
  );
  const shapes = new Map<number, number[]>();
  const dir = await mkdtemp(join(resolve(scratch), "display-pack-"));
  try {
    const input = join(dir, "input.geojson"),
      output = join(dir, "output.geojson");
    const file = await open(input, "w");
    try {
      await file.writeFile('{"type":"FeatureCollection","features":[');
      for (let i = 0; i < records.length; i++) {
        signal.throwIfAborted();
        const r = records[i]!;
        if (r.kind !== 3 || (r.class !== 0 && r.class !== 1)) continue;
        const view = new DataView(
          r.bytes.buffer,
          r.bytes.byteOffset,
          r.bytes.byteLength,
        );
        const polygons: Polygon[] = [];
        let at = r.geometryOffset;
        for (let p = 0; p < r.parts; p++) {
          const n = view.getUint32(at, true);
          at += 4;
          const ring: Ring = [];
          for (let j = 0; j < n; j++, at += 4)
            ring.push([view.getUint16(at, true), view.getUint16(at + 2, true)]);
          if (area(ring) > 0) polygons.push([ring]);
          else if (polygons.length) polygons.at(-1)!.push(ring);
          else throw new Error(`Tile ${key} contains an orphan hole`);
        }
        if (!polygons.length)
          throw new Error(`Tile ${key} contains an empty polygon`);
        await file.writeFile(
          (shapes.size ? "," : "") +
            JSON.stringify({
              type: "Feature",
              properties: { atlas_record: i },
              geometry: { type: "MultiPolygon", coordinates: polygons },
            }),
        );
        shapes.set(
          i,
          polygons.map((p) => p.length),
        );
      }
      await file.writeFile("]}");
    } finally {
      await file.close();
    }
    if (!shapes.size) return parts;
    onMessage(
      `Generalizing crowded display tile ${key}; analysis geometry unchanged`,
    );
    await runCompiler(
      [
        "ogr2ogr",
        "-f",
        "GeoJSON",
        output,
        input,
        "-simplify",
        String(TILE_EXTENT / 512 / 4),
        "-a_srs",
        "NONE",
        "-dim",
        "XY",
        "-lco",
        "COORDINATE_PRECISION=0",
      ],
      dir,
      signal,
      onMessage,
    );
    signal.throwIfAborted();
    if (Bun.file(output).size > 64 * 1024 ** 2)
      throw new Error(
        `Tile ${key} still needs finer partitioning after quarter-pixel generalization`,
      );
    const result = await Bun.file(output).json();
    if (
      result.type !== "FeatureCollection" ||
      result.features?.length !== shapes.size
    )
      throw new Error(`Tile ${key} generalization lost features`);
    const seen = new Set<number>();
    let retained = 0;
    for (const f of result.features) {
      const id = f.properties?.atlas_record,
        expected = shapes.get(id);
      if (!expected || seen.has(id))
        throw new Error(
          `Tile ${key} generalization changed feature identities`,
        );
      seen.add(id);
      const polygons: Polygon[] =
        f.geometry?.type === "Polygon"
          ? [f.geometry.coordinates]
          : f.geometry?.type === "MultiPolygon"
            ? f.geometry.coordinates
            : [];
      // Quantized legacy geometry can already be degenerate. Keep the whole
      // original record when GEOS cannot produce valid rings with the same
      // components/holes; never substitute a broken or incomplete simplification.
      if (!validGeneralizedPolygons(polygons, expected)) {
        retained++;
        continue;
      }
      for (const polygon of polygons)
        for (let i = 0; i < polygon.length; i++)
          if (area(polygon[i]!) > 0 !== (i === 0)) polygon[i]!.reverse();
      const encoded = encodeTile([
        {
          type: 3,
          tags: { class: records[id]!.class },
          geometry: polygons.flat() as unknown as geojsonvt.Feature["geometry"],
        },
      ]);
      records[id]!.bytes = encoded.subarray(8);
    }
    if (retained)
      onMessage(
        `Kept ${retained} original polygon records in ${key} because generalization could not preserve their rings`,
      );
    // One record per part keeps the existing per-part decoder limits active.
    return records.map((r) => {
      const b = new Uint8Array(8 + r.bytes.length);
      b.set(new TextEncoder().encode("TIL2"));
      new DataView(b.buffer).setUint32(4, 1, true);
      b.set(r.bytes, 8);
      return b;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Acceptance gate for a display-only replacement. False keeps original bytes. */
export function validGeneralizedPolygons(
  polygons: Polygon[],
  expected: number[],
): boolean {
  if (
    polygons.length !== expected.length ||
    polygons.some((p, i) => p.length !== expected[i])
  )
    return false;
  return polygons.every((p) =>
    p.every(
      (ring) =>
        ring.length >= 4 &&
        ring.every(
          (p) =>
            p.length === 2 &&
            p.every((n) => Number.isInteger(n) && n >= 0 && n <= TILE_EXTENT),
        ) &&
        ring[0]![0] === ring.at(-1)![0] &&
        ring[0]![1] === ring.at(-1)![1] &&
        area(ring) !== 0,
    ),
  );
}
