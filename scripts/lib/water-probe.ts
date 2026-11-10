import { project, TILE_EXTENT } from "../../packages/format/src/index";
import { tileRecords } from "../../packages/format/src/tiles";
export function coversWater(
  bytes: Uint8Array,
  point: [number, number],
  z: number,
  x: number,
  y: number,
) {
  const [wx, wy] = project(...point),
    px = (wx * 2 ** z - x) * TILE_EXTENT,
    py = (wy * 2 ** z - y) * TILE_EXTENT;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const r of tileRecords(bytes)) {
    if (r.class !== 1 || r.kind !== 3) continue;
    let at = r.geometryOffset,
      inside = false;
    for (let part = 0; part < r.parts; part++) {
      const n = v.getUint32(at, true);
      at += 4;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = v.getUint16(at + i * 4, true),
          ay = v.getUint16(at + i * 4 + 2, true),
          bx = v.getUint16(at + j * 4, true),
          by = v.getUint16(at + j * 4 + 2, true);
        if (
          ay > py !== by > py &&
          px < ((bx - ax) * (py - ay)) / (by - ay) + ax
        )
          inside = !inside;
      }
      at += n * 4;
    }
    if (inside) return true;
  }
  return false;
}
