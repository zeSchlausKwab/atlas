import { layerForClass, type MapLayer } from "./index";
/** Split TIL1 records without changing coordinate precision, parts, winding or holes. */
export function splitTile(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 8 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "TIL1"
  )
    throw new Error("Invalid tile magic");
  const count = v.getUint32(4, true);
  if (count > 500000) throw new Error("Tile feature limit exceeded");
  const groups = new Map<MapLayer, Uint8Array[]>();
  let cursor = 8,
    points = 0;
  for (let i = 0; i < count; i++) {
    const start = cursor;
    if (cursor + 4 > bytes.length) throw new Error("Truncated tile feature");
    const layer = layerForClass(v.getUint8(cursor)),
      type = v.getUint8(cursor + 1),
      parts = v.getUint16(cursor + 2, true);
    cursor += 4;
    if (type < 1 || type > 3) throw new Error("Invalid tile geometry");
    for (let p = 0; p < parts; p++) {
      if (cursor + 4 > bytes.length) throw new Error("Truncated tile part");
      const n = v.getUint32(cursor, true);
      points += n;
      cursor += 4 + n * 4;
      if (points > 3000000 || cursor > bytes.length)
        throw new Error("Invalid tile point count");
    }
    const records = groups.get(layer) ?? [];
    records.push(bytes.subarray(start, cursor));
    groups.set(layer, records);
  }
  if (cursor !== bytes.length) throw new Error("Trailing tile bytes");
  return [...groups].map(([layer, records]) => {
    const output = new Uint8Array(
      8 + records.reduce((n, r) => n + r.length, 0),
    );
    output.set(bytes.subarray(0, 4));
    new DataView(output.buffer).setUint32(4, records.length, true);
    let offset = 8;
    for (const record of records) {
      output.set(record, offset);
      offset += record.length;
    }
    return { layer, features: records.length, bytes: output };
  });
}
