import { clipSegment, interpolate, type Polygon } from "./geometry";
import type { Position } from "../../geocoding/src/model";
/** Preserve original node identity and direction flags. Each cut gets its own synthetic node. */
export function clipGraph(bytes: Uint8Array, polygon: Polygon) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "RTE1"
  )
    throw new Error("Invalid graph");
  const n = v.getUint32(4, true),
    e = v.getUint32(8, true),
    base = 12 + n * 24;
  if (n > 8_000_000 || e > 12_000_000 || bytes.length !== base + e * 20)
    throw new Error("Invalid graph length");
  const nodes: { id: bigint; p: Position }[] = [],
    edges: { a: number; b: number; way: bigint; d: number }[] = [];
  const retained = new Map<number, number>();
  let synthetic = -1n;
  // Original files may already contain synthetic IDs from a previous extraction.
  for (let i = 0; i < n; i++) {
    const id = v.getBigInt64(12 + i * 24, true);
    if (id <= synthetic) synthetic = id - 1n;
  }
  const position = (i: number): Position => [
    v.getFloat64(20 + i * 24, true),
    v.getFloat64(28 + i * 24, true),
  ];
  function node(i: number, p: Position, original: boolean) {
    if (original && retained.has(i)) return retained.get(i)!;
    const index = nodes.length;
    nodes.push({
      id: original ? v.getBigInt64(12 + i * 24, true) : synthetic--,
      p,
    });
    if (original) retained.set(i, index);
    return index;
  }
  for (let i = 0; i < e; i++) {
    const o = base + i * 20,
      ai = v.getUint32(o, true),
      bi = v.getUint32(o + 4, true),
      d = v.getUint8(o + 16);
    if (ai >= n || bi >= n || ai === bi || d < 1 || d > 3)
      throw new Error("Invalid graph edge");
    const a = position(ai),
      b = position(bi);
    for (const [lo, hi] of clipSegment(a, b, polygon))
      edges.push({
        a: node(ai, interpolate(a, b, lo), lo === 0),
        b: node(bi, interpolate(a, b, hi), hi === 1),
        way: v.getBigInt64(o + 8, true),
        d,
      });
  }
  const output = new Uint8Array(12 + nodes.length * 24 + edges.length * 20),
    w = new DataView(output.buffer);
  output.set(new TextEncoder().encode("RTE1"));
  w.setUint32(4, nodes.length, true);
  w.setUint32(8, edges.length, true);
  nodes.forEach((n, i) => {
    const o = 12 + i * 24;
    w.setBigInt64(o, n.id, true);
    w.setFloat64(o + 8, n.p[0], true);
    w.setFloat64(o + 16, n.p[1], true);
  });
  edges.forEach((s, i) => {
    const o = 12 + nodes.length * 24 + i * 20;
    w.setUint32(o, s.a, true);
    w.setUint32(o + 4, s.b, true);
    w.setBigInt64(o + 8, s.way, true);
    w.setUint8(o + 16, s.d);
  });
  return { bytes: output, nodes: nodes.length, segments: edges.length };
}
