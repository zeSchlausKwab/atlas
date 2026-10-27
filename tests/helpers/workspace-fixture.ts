import type { Feature, Polygon } from "geojson";
import { buildFeatures } from "../../packages/features/src/compile";
import { encodePackage } from "../../packages/format/src/writer";
import { AtlasReader, FileSource } from "../../packages/format/src/reader";
import { buildGeocoding } from "../../packages/geocoding/src/compile";
import {
  SEMANTIC_RETENTION,
  type Location,
} from "../../packages/geocoding/src/model";
import type { Bounds } from "../../packages/features/src/index";
export const taskBounds: Bounds = [16, 48, 16.02, 48.02];
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export async function workspaceFixture(
  bounds: Bounds = taskBounds,
  height = "18",
  extraRead?: () => void,
) {
  const building: Feature<Polygon> = {
    type: "Feature",
    properties: {
      id: "way/10",
      class: 2,
      name: "Corner building",
      tags: {
        building: "yes",
        height,
        "addr:street": "Testgasse",
        "addr:housenumber": "12",
        "addr:city": "Wien",
        "addr:postcode": "1010",
      },
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [16.009, 48.009],
          [16.011, 48.009],
          [16.011, 48.011],
          [16.009, 48.011],
          [16.009, 48.009],
        ],
      ],
    },
  };
  const nodes: Location[] = [
    {
      id: "node/1",
      name: "Coffee One",
      kind: "poi",
      category: "cafe",
      aliases: [],
      coordinates: [16.005, 48.005],
      tags: {
        amenity: "cafe",
        wheelchair: "yes",
        "addr:housenumber": "1",
        "addr:street": "Testgasse",
      },
    },
    {
      id: "node/2",
      name: "Coffee Two",
      kind: "poi",
      category: "cafe",
      aliases: [],
      coordinates: [16.015, 48.005],
      tags: { amenity: "cafe" },
    },
  ];
  const retainedNodes = nodes.filter(
    (r) => r.coordinates[0] >= bounds[0] && r.coordinates[0] <= bounds[2],
  );
  const fc = { type: "FeatureCollection" as const, features: [building] },
    geo = buildGeocoding(retainedNodes, fc);
  const cells = buildFeatures(fc);
  const bytes = await encodePackage(
    {
      format: "atlas",
      version: 1,
      name: "Task demo",
      source: {
        url: "fixture",
        sha256: "a".repeat(64),
        attribution: "Synthetic test data",
      },
      bounds,
      minZoom: 0,
      maxZoom: 16,
      features: 1,
      places: [],
      peaks: 0,
      featureZoom: 12,
      featureKinds: ["buildings"],
      tileLayers: ["buildings"],
      semantics: SEMANTIC_RETENTION,
      capabilities: [
        "feature-extraction",
        "location-search",
        "address-search",
        "semantic-locations",
      ],
      limitations: [],
    },
    [
      {
        key: "search/locations",
        bytes: encode({
          ...geo.locations,
          records: geo.locations.records.filter(
            (r) =>
              r.coordinates[0] >= bounds[0] && r.coordinates[0] <= bounds[2],
          ),
        }),
      },
      ...[...cells].map(([key, features]) => ({
        key,
        bytes: encode({ schema: "features-v1", features }),
      })),
      { key: "tile/buildings/0/0/0", bytes: new Uint8Array([0, 0, 0, 0]) },
    ],
    { paged: true },
  );
  const source = new FileSource(new Blob([bytes]));
  const reader = await new AtlasReader({
    read: (a, b, s) => {
      extraRead?.();
      return source.read(a, b);
    },
  }).open();
  return { reader, bytes, building, geo };
}
