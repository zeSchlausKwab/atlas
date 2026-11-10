import type { Manifest } from "../../format/src/index";
import {
  OSM_ROUTING_CONTRACT,
  validateRoutingFederation,
  type RoutingFederation,
} from "../../format/src/routing-contract";

/** Only our complete-way/restriction extraction receipts qualify. A filename or
 * calendar date cannot establish that two regional inputs share OSM identity. */
export function routingAuthority(
  source: Pick<Manifest["source"], "inputs" | "extraction">,
): RoutingFederation | undefined {
  const extraction = source.extraction,
    parent = source.inputs?.[0];
  if (
    !parent ||
    !extraction ||
    !extraction.strategy.startsWith("smart;") ||
    !/types=[^;]*\brestriction\b/.test(extraction.strategy)
  )
    return undefined;
  const federation: RoutingFederation = {
    version: 1,
    namespace: "openstreetmap",
    sourceRevision: parent.sha256,
    contract: OSM_ROUTING_CONTRACT,
    segmentIdentity: "osm-way-segment-v1",
    completeBounds: [...extraction.bounds] as [number, number, number, number],
  };
  validateRoutingFederation(federation);
  return federation;
}
