import type geojsonvt from "geojson-vt";
import { TILE_EXTENT } from "../../format/src/index";
import { buildingHeight } from "../../format/src/heights";
export function encodeTile(features: geojsonvt.Feature[]): Uint8Array {
  const normalized = features.map((f) => ({
    class: Number(f.tags?.class ?? 3),
    type: f.type,
    height: buildingHeight(f.tags?.tags as Record<string, unknown> | undefined),
    parts: (f.type === 1 ? [f.geometry] : f.geometry) as number[][][],
  }));
  const length =
    8 +
    normalized.reduce(
      (n, f) =>
        n +
        4 +
        (f.class === 2 ? 9 : 0) +
        f.parts.reduce((n, p) => n + 4 + p.length * 4, 0),
      0,
    );
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("TIL2"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, features.length, true);
  let pos = 8;
  for (const f of normalized) {
    if (f.parts.length > 65535) throw new Error("Tile part limit exceeded");
    view.setUint8(pos++, f.class);
    view.setUint8(pos++, f.type);
    view.setUint16(pos, f.parts.length, true);
    pos += 2;
    if (f.class === 2) {
      view.setFloat32(pos, f.height.height, true);
      view.setFloat32(pos + 4, f.height.minHeight, true);
      view.setUint8(pos + 8, f.height.source);
      pos += 9;
    }
    for (const part of f.parts) {
      view.setUint32(pos, part.length, true);
      pos += 4;
      for (const point of part) {
        view.setUint16(
          pos,
          Math.max(0, Math.min(TILE_EXTENT, Math.round(point[0]!))),
          true,
        );
        view.setUint16(
          pos + 2,
          Math.max(0, Math.min(TILE_EXTENT, Math.round(point[1]!))),
          true,
        );
        pos += 4;
      }
    }
  }
  return bytes;
}
