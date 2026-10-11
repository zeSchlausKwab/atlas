import { TILE_EXTENT } from "../../format/src/index";
import { tileRecords } from "../../format/src/tiles";

/** Cartographic display filtering only; source/query geometry is never changed.
 * One pixel of area on a 512px tile. Detail tiles (z13+) retain every record,
 * including tiny buildings and water features used during client overzoom.
 * Run both before spooling and while packing so older checkpoints remain usable.
 */
export function compactDisplayTile(
  bytes: Uint8Array,
  zoom: number,
): Uint8Array {
  if (zoom >= 13) return bytes;
  const minimumArea = (TILE_EXTENT / 512) ** 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: Uint8Array[] = [];
  let changed = false;
  for (const record of tileRecords(bytes)) {
    if (record.kind !== 3 || (record.class !== 0 && record.class !== 1)) {
      records.push(bytes.subarray(record.start, record.end));
      continue;
    }
    const rings: Uint8Array[] = [];
    let cursor = record.geometryOffset,
      keepExterior = false;
    for (let part = 0; part < record.parts; part++) {
      const start = cursor,
        count = view.getUint32(cursor, true);
      cursor += 4;
      let twiceArea = 0;
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        twiceArea +=
          view.getUint16(cursor + i * 4, true) *
            view.getUint16(cursor + j * 4 + 2, true) -
          view.getUint16(cursor + j * 4, true) *
            view.getUint16(cursor + i * 4 + 2, true);
      }
      cursor += count * 4;
      // geojson-vt emits clockwise exteriors in screen coordinates (positive
      // shoelace area), followed by negative holes. Never promote an orphan
      // hole when its small exterior has been removed. Retain all nonzero
      // holes of a retained exterior, even when the holes themselves are tiny.
      if (twiceArea > 0) keepExterior = twiceArea / 2 >= minimumArea;
      if (twiceArea !== 0 && keepExterior)
        rings.push(bytes.subarray(start, cursor));
    }
    if (rings.length === record.parts) {
      records.push(bytes.subarray(record.start, record.end));
    } else {
      changed = true;
      if (!rings.length) continue;
      const output = new Uint8Array(
        4 + rings.reduce((n, ring) => n + ring.length, 0),
      );
      output.set(bytes.subarray(record.start, record.start + 4));
      new DataView(output.buffer).setUint16(2, rings.length, true);
      let at = 4;
      for (const ring of rings) {
        output.set(ring, at);
        at += ring.length;
      }
      records.push(output);
    }
  }
  if (!changed) return bytes;
  const output = new Uint8Array(
    8 + records.reduce((n, record) => n + record.length, 0),
  );
  output.set(bytes.subarray(0, 4));
  new DataView(output.buffer).setUint32(4, records.length, true);
  let at = 8;
  for (const record of records) {
    output.set(record, at);
    at += record.length;
  }
  return output;
}
