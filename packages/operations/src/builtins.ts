import type { AtlasEngine } from "./index";
import {
  type Plugin,
  objectSchema,
  positionSchema,
  polygonSchema,
  jsonResultSchema,
  featureResultSchema,
} from "./registry";
import { validateFeatureQuery, FEATURE_KINDS } from "../../features/src/index";
import { validateTransport } from "../../routing/src/index";
import { validatePolygon } from "../../offline/src/geometry";
import { normalize } from "../../geocoding/src/model";
const profile = {
  type: "string",
  enum: ["walking", "cycling", "driving"],
  default: "walking",
};
export function builtins(e: AtlasEngine): Plugin[] {
  const specs = [
    {
      id: "route",
      title: "Route",
      description: "Find a route using the package transport graph.",
      purposes: ["routing"],
      schema: objectSchema(
        { start: positionSchema, end: positionSchema, profile },
        ["start", "end"],
      ),
      validate: (i: any) => validateTransport(i.profile ?? "walking"),
      run: (i: any) => e.route(i.start, i.end, i.profile),
    },
    {
      id: "isochrone",
      title: "Reachability",
      description: "Reachable regions for travel-time bands in seconds.",
      purposes: ["routing"],
      schema: objectSchema(
        {
          start: positionSchema,
          bands: {
            type: "array",
            items: { type: "integer", minimum: 1, maximum: 1800 },
            minItems: 1,
            maxItems: 4,
          },
          profile,
        },
        ["start", "bands"],
      ),
      validate: (i: any) => validateTransport(i.profile ?? "walking", i.bands),
      run: (i: any) => e.isochrone(i.start, i.bands, i.profile),
    },
    {
      id: "search",
      title: "Search",
      description: "Search locations retained in this package.",
      purposes: ["search"],
      schema: objectSchema(
        {
          query: { type: "string", minLength: 2, maxLength: 120 },
          limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
        },
        ["query"],
      ),
      validate: (i: any) => {
        if (normalize(i.query).length < 2)
          throw new Error("Invalid search query");
      },
      run: (i: any) => e.search(i.query, i.limit),
    },
    {
      id: "reverse",
      title: "Nearest street",
      description: "Find the nearest retained street to a coordinate.",
      purposes: ["search"],
      schema: objectSchema({ point: positionSchema }),
      run: (i: any) => e.reverse(i.point),
    },
    {
      id: "peak",
      title: "Highest peak",
      description:
        "Highest recorded elevation among peaks retained in this package; not a terrain maximum.",
      purposes: ["queries"],
      schema: objectSchema({}),
      run: () => e.peak(),
    },
    {
      id: "features",
      title: "Extract features",
      description:
        "Selectable source objects intersecting a geographic bounding box.",
      purposes: ["features"],
      schema: objectSchema(
        {
          kind: { type: "string", enum: [...FEATURE_KINDS] },
          bounds: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4,
          },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
          tag: { type: "string", maxLength: 150 },
        },
        ["kind", "bounds"],
      ),
      validate: validateFeatureQuery,
      run: (i: any, c: any) => e.features.query(i, c.signal),
    },
    {
      id: "offline",
      title: "Export offline package",
      description: "Create a selected offline atlas file.",
      purposes: [],
      schema: objectSchema(
        {
          polygon: polygonSchema,
          name: { type: "string", maxLength: 80 },
          minZoom: { type: "integer", minimum: 0, maximum: 20 },
          maxZoom: { type: "integer", minimum: 0, maximum: 20 },
          routing: { type: "boolean" },
          search: { type: "boolean" },
          queries: { type: "boolean" },
          layers: { type: "array", items: { type: "string" } },
          placeNames: { type: "boolean" },
          streetNames: { type: "boolean" },
          pois: { type: "boolean" },
        },
        ["polygon", "name", "minZoom", "maxZoom", "routing", "search"],
      ),
      validate: (i: any) => validatePolygon(i.polygon),
      run: (i: any) => e.offline(i),
    },
  ];
  return specs.map((s) => ({
    descriptor: {
      id: s.id,
      version: "1.0.0",
      title: s.title,
      description: s.description,
      inputSchema: s.schema,
      outputSchema:
        s.id === "features" ? featureResultSchema : jsonResultSchema,
      purposes: s.purposes,
      requirements: e.capabilities.operations[
        s.id as keyof typeof e.capabilities.operations
      ].dependencies.map((d) => ({
        family: d.family,
        schema: `${d.schema}-v${d.versions.join("/")}`,
        ...("optional" in d ? { optional: d.optional } : {}),
        ...("profile" in d ? { profile: d.profile } : {}),
      })),
      result:
        s.id === "features" ? "geojson" : s.id === "offline" ? "file" : "json",
      execution: ["device", "server"],
      federation: "single-executor",
    },
    available: () =>
      e.capabilities.operations[s.id as keyof typeof e.capabilities.operations]
        .available,
    validate: s.validate,
    run: s.run,
  }));
}
