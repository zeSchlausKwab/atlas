import {
  TRANSPORT_MODES,
  type TransportMode,
  type TransportMetadata,
} from "./index";
/** Independent OSM extracts share source authority, never package/build ordinals.
 * This first contract deliberately requires one exact upstream PBF revision.
 * A source date, file name, or matching OSM node ID is not a revision proof.
 */
export const OSM_ROUTING_CONTRACT = "atlas-osm-transport-v1";
export interface RoutingFederation {
  version: 1;
  namespace: "openstreetmap";
  sourceRevision: string;
  contract: typeof OSM_ROUTING_CONTRACT;
  segmentIdentity: "osm-way-segment-v1";
  /** Extraction envelope with complete ways and restriction relations. Only
   * cells wholly inside this envelope may own junctions in a federation. */
  completeBounds: [number, number, number, number];
}
export function validateRoutingFederation(value: RoutingFederation) {
  const b = value?.completeBounds;
  if (
    !value ||
    value.version !== 1 ||
    value.namespace !== "openstreetmap" ||
    typeof value.sourceRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceRevision) ||
    value.contract !== OSM_ROUTING_CONTRACT ||
    value.segmentIdentity !== "osm-way-segment-v1" ||
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    b[0] < -180 ||
    b[2] > 180 ||
    b[1] < -85 ||
    b[3] > 85 ||
    b[0] >= b[2] ||
    b[1] >= b[3]
  )
    throw new Error("Invalid OSM routing federation contract");
}
export function federationIdentity(f: RoutingFederation) {
  return `${f.namespace}:${f.sourceRevision}:${f.contract}:${f.segmentIdentity}`;
}
export function ownsRoutingCell(f: RoutingFederation, x: number, y: number) {
  const n = 16384;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= n ||
    y >= n
  )
    return false;
  const latitude = (v: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  const b = f.completeBounds;
  return (
    (x / n) * 360 - 180 > b[0] &&
    ((x + 1) / n) * 360 - 180 < b[2] &&
    latitude(y + 1) > b[1] &&
    latitude(y) < b[3]
  );
}

/** One manifest describes all profiles, so their coverage claim must agree too. */
export function sameRoutingFederation(
  a?: RoutingFederation,
  b?: RoutingFederation,
) {
  if (!a || !b) return a === b;
  return (
    federationIdentity(a) === federationIdentity(b) &&
    a.completeBounds.every((v, i) => v === b.completeBounds[i])
  );
}

/** Validate discovery claims with the same rules as an opened archive. */
export function validateTransportMetadata(
  transport: TransportMetadata | undefined,
  capabilities: string[],
) {
  if (transport) {
    if (transport.federation) validateRoutingFederation(transport.federation);
    if (
      transport.version !== 1 ||
      (transport.graphSnapshot !== undefined &&
        !/^[a-f0-9]{64}$/.test(transport.graphSnapshot)) ||
      !transport.profiles ||
      Object.keys(transport.profiles).length === 0 ||
      Object.keys(transport.profiles).some(
        (k) => !TRANSPORT_MODES.includes(k as TransportMode),
      )
    )
      throw new Error("Invalid transport metadata");
    for (const mode of TRANSPORT_MODES) {
      const p = transport.profiles[mode];
      if (!p) continue;
      if (
        p.prefix !== `routing/${mode}/cells` ||
        p.zoom !== 14 ||
        !["rcl2", "rcl3"].includes(p.codec) ||
        !!transport.federation !== (p.codec === "rcl3") ||
        ![
          p.count,
          p.nodes,
          p.segments,
          p.turns,
          p.skippedWays,
          p.unsupportedRestrictions,
          p.excludedRestrictionWays,
        ].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error("Invalid transport profile");
    }
  }
  if (capabilities.includes("transport-routing") !== !!transport)
    throw new Error("Transport capability mismatch");
}
