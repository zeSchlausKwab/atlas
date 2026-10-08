import { layerForClass, type MapLayer } from "./index";
import { validBuildingHeight, type BuildingHeight } from "./heights";
/** Validate both codecs while exposing byte-exact records for split/export/audit. */
export function* tileRecords(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (bytes.length < 8 || !["TIL1", "TIL2"].includes(magic))
    throw new Error("Invalid tile magic");
  const count = v.getUint32(4, true);
  if (count > 500000) throw new Error("Tile feature limit exceeded");
  let cursor = 8,
    points = 0;
  for (let i = 0; i < count; i++) {
    const start = cursor;
    if (cursor + 4 > bytes.length) throw new Error("Truncated tile feature");
    const cls = v.getUint8(cursor),
      layer = layerForClass(cls),
      kind = v.getUint8(cursor + 1),
      parts = v.getUint16(cursor + 2, true);
    cursor += 4;
    if (kind < 1 || kind > 3) throw new Error("Invalid tile geometry");
    let height: BuildingHeight | undefined;
    if (magic === "TIL2" && cls === 2) {
      if (cursor + 9 > bytes.length)
        throw new Error("Truncated building height");
      height = {
        height: v.getFloat32(cursor, true),
        minHeight: v.getFloat32(cursor + 4, true),
        source: v.getUint8(cursor + 8),
      };
      cursor += 9;
      if (!validBuildingHeight(height))
        throw new Error("Invalid building height");
    }
    const geometryOffset = cursor;
    let pointCount = 0;
    for (let p = 0; p < parts; p++) {
      if (cursor + 4 > bytes.length) throw new Error("Truncated tile part");
      const n = v.getUint32(cursor, true);
      points += n;
      pointCount += n;
      cursor += 4 + n * 4;
      if (points > 3000000 || cursor > bytes.length)
        throw new Error("Invalid tile point count");
    }
    yield {
      start,
      end: cursor,
      class: cls,
      layer,
      kind,
      parts,
      pointCount,
      geometryOffset,
      height,
    };
  }
  if (cursor !== bytes.length) throw new Error("Trailing tile bytes");
}
/** Splitting never changes coordinate precision, height attributes, winding or holes. */
export function splitTile(bytes: Uint8Array) {
  const groups = new Map<MapLayer, Uint8Array[]>();
  for (const r of tileRecords(bytes)) {
    const records = groups.get(r.layer) ?? [];
    records.push(bytes.subarray(r.start, r.end));
    groups.set(r.layer, records);
  }
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
