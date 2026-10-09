import { AtlasReader, FileSource } from "../../packages/format/src/reader";
import {
  encodePackage,
  type InputBlock,
} from "../../packages/format/src/writer";
import {
  project,
  TRANSPORT_MODES,
  type Manifest,
  type TransportMetadata,
} from "../../packages/format/src/index";
import { AtlasRouter, type Position } from "../../packages/routing/src/index";
export const points: Position[] = [
  [16, 48],
  [16.002, 48],
  [16.004, 48],
];
function graph(mode: number) {
  const bytes = new Uint8Array(20 + 3 * 24 + 2 * 28),
    v = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RTE2"));
  v.setUint32(4, 3, true);
  v.setUint32(8, 2, true);
  v.setUint32(16, mode, true);
  points.forEach((p, i) => {
    const at = 20 + i * 24;
    v.setBigInt64(at, BigInt(i + 1), true);
    v.setFloat64(at + 8, p[0], true);
    v.setFloat64(at + 16, p[1], true);
  });
  for (let i = 0; i < 2; i++) {
    const at = 92 + i * 28;
    v.setUint32(at, i, true);
    v.setUint32(at + 4, i + 1, true);
    v.setBigInt64(at + 8, BigInt(i + 10), true);
    v.setUint8(at + 16, mode === 2 ? 1 : 3);
    v.setFloat32(at + 20, [120, 40, 20][mode]!, true);
    v.setFloat32(at + 24, [120, 60, 40][mode]!, true);
  }
  return bytes;
}
export async function transportFixture() {
  const inputs: InputBlock[] = [],
    profiles = {} as TransportMetadata["profiles"];
  const start = project(...points[0]!).map((v) => Math.floor(v * 16384)),
    end = project(...points[2]!).map((v) => Math.floor(v * 16384));
  for (const [mode, name] of TRANSPORT_MODES.entries()) {
    let count = 0;
    const prefix = `routing/${name}/cells`;
    for (let x = start[0]!; x <= end[0]!; x++) {
      const raw = graph(mode),
        bytes = new Uint8Array(16 + raw.length + 8),
        v = new DataView(bytes.buffer);
      bytes.set(new TextEncoder().encode("RCL2"));
      v.setUint32(4, 14, true);
      v.setUint32(8, x, true);
      v.setUint32(12, start[1]!, true);
      bytes.set(raw, 16);
      v.setUint32(16 + raw.length + 4, 1, true);
      inputs.push({ key: `${prefix}/14/${x}/${start[1]}`, bytes });
      count++;
    }
    profiles[name] = {
      prefix,
      zoom: 14,
      count,
      codec: "rcl2",
      nodes: 3,
      segments: 2,
      turns: 0,
      skippedWays: 0,
      unsupportedRestrictions: 0,
      excludedRestrictionWays: 0,
    };
  }
  const manifest: Omit<Manifest, "snapshot"> = {
    format: "atlas",
    version: 1,
    name: "Transport fixture",
    source: { url: "fixture", sha256: "0".repeat(64), attribution: "Test" },
    bounds: [15.9, 47.9, 16.1, 48.1],
    minZoom: 0,
    maxZoom: 0,
    features: 0,
    peaks: 0,
    places: [],
    capabilities: ["transport-routing"],
    limitations: [],
    transport: { version: 1, profiles },
  };
  const bytes = await encodePackage(manifest, inputs, { paged: true });
  const open = () => new AtlasReader(new FileSource(new Blob([bytes]))).open();
  const reader = await open();
  return {
    reader,
    open,
    manifest,
    inputs,
    router: new AtlasRouter(reader, async () => {}),
  };
}
