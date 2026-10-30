import { objectSchema, positionSchema } from "../../operations/src/registry";
export const acquisitionSpecs: Array<
  [string, string, Record<string, unknown>]
> = [
  [
    "acquisition_catalog",
    "List selected map revisions and capabilities available for browser-side acquisition. This does not discover arbitrary servers or change selected maps.",
    objectSchema({}),
  ],
  [
    "acquisition_plan",
    "Plan a saved area on this device across selected maps. Explicit polygon coordinates [longitude,latitude] and families are required: never assume the viewport. Resolve named places first. Returns a job ID, byte estimate, per-capability coverage/gaps and routing conflicts. Planning reads indexes; it does not download all payloads. Review before acquisition. Capabilities include tile:water, tile:roads, routing:walking/cycling/driving, search, features:buildings, objects, boundaries, raster:<id>.",
    objectSchema(
      {
        name: { type: "string", minLength: 1, maxLength: 80 },
        polygon: { type: "array", items: positionSchema, minItems: 3 },
        families: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          uniqueItems: true,
        },
        sourceIds: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
        },
        minZoom: { type: "integer", minimum: 0, maximum: 24 },
        maxZoom: { type: "integer", minimum: 0, maximum: 24 },
        paddingCells: { type: "integer", minimum: 0, maximum: 4 },
      },
      ["name", "polygon", "families", "minZoom", "maxZoom"],
    ),
  ],
  [
    "acquisition_save",
    "Fetch and pin a reviewed saved-area job in the browser. Resumes verified blocks after interruption and reports live progress. Use only when the user requested downloading/saving this area. Coverage gaps require explicit agreement before acceptPartial:true; storage risk requires explicit agreement before allowStorageRisk:true. Never accept either silently. Routing conflicts cannot be overridden. This is a persistent block cache, not a standalone .atlas export; global text search and routes outside the area may still need more reads.",
    objectSchema(
      {
        id: { type: "string" },
        acceptPartial: { type: "boolean" },
        allowStorageRisk: { type: "boolean" },
      },
      ["id"],
    ),
  ],
  [
    "acquisition_status",
    "List saved-area plans, progress, gaps and local completion. Ready means selected blocks were persisted, not complete real-world data or universal offline coverage. No geometry or huge block lists are returned.",
    objectSchema({}),
  ],
];
