import { MAP_LAYERS, TRANSPORT_MODES } from "../packages/format/src/index";
import { OSM_ROUTING_CONTRACT } from "../packages/format/src/routing-contract";
import { FEATURE_KINDS } from "../packages/features/src/index";
import type { PackageSelection } from "../packages/provisioning/src/selection";
import recipe from "../recipes/europe-three-map-demo.json";
export function europeDemoPlan(
  config: {
    cachedSources: Array<{ id: string; kind: string; sha256?: string }>;
    oceanSource?: { sha256: string };
    globalSource: { snapshot: string };
    routingCompiler?: { authority: string; contract: string; codec: string };
  },
  east = 27,
) {
  if (!Number.isFinite(east) || east < 20 || east > 35)
    throw Error(
      "Eastern edge must be 20–35°E and include the two smaller regions",
    );
  const source = config.cachedSources.find((s) => s.kind === "planet");
  if (!source?.sha256) throw Error("Register a verified cached planet first");
  if (!config.oceanSource)
    throw Error("Configure the verified assembled ocean source and GDAL first");
  if (
    config.routingCompiler?.authority !== "osm-pbf-sha256" ||
    config.routingCompiler.contract !== OSM_ROUTING_CONTRACT ||
    config.routingCompiler.codec !== "rcl3"
  )
    throw Error(
      "Deploy the OSM-authoritative routing compiler before queuing independent maps",
    );
  return {
    source: source.id,
    sourceRevision: source.sha256,
    maps: recipe.maps.map((m) => {
      const [w, s, e, n] = m.key === "western" ? [-15, 34, east, 65] : m.bounds;
      const selection: PackageSelection & { cachedSourceId: string } = {
        name: m.name,
        snapshot: config.globalSource.snapshot,
        polygon: [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
        ],
        minZoom: 0,
        maxZoom: 16,
        layers: [...MAP_LAYERS],
        profiles: [...TRANSPORT_MODES],
        featureKinds: [...FEATURE_KINDS],
        placeNames: true,
        streetNames: true,
        pois: true,
        search: true,
        reverse: true,
        peaks: true,
        paddingCells: 2,
        maxBytes: m.maxBytes,
        cachedSourceId: source.id,
        ocean: { sha256: config.oceanSource!.sha256 },
      };
      return { key: m.key, targetBytes: m.targetBytes, selection };
    }),
  };
}
