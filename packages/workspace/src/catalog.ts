import type { Manifest } from "../../format/src/index";
import { FEATURE_KINDS, type FeatureKind } from "../../features/src/index";
export const FAMILIES = ["locations", ...FEATURE_KINDS] as const;
export type Family = "locations" | FeatureKind;
export function supports(m: Manifest, family: Family) {
  return family === "locations"
    ? m.capabilities.includes("location-search")
    : m.capabilities.includes("feature-extraction") &&
        m.featureZoom !== undefined &&
        (m.featureKinds ?? FEATURE_KINDS).includes(family);
}
/** No payload reads. Metadata describes retained data, never real-world completeness. */
export function describeData(
  m: Manifest,
  policy: "bounded" | "interactive" = "bounded",
) {
  return {
    version: 1,
    snapshot: m.snapshot,
    name: m.name,
    source: m.source,
    bounds: m.bounds,
    polygon: m.selection?.polygon ?? null,
    scope: "retained-source-data",
    realWorldCompleteness: "unknown",
    coordinates: {
      crs: "EPSG:4326",
      order: ["longitude", "latitude"],
      units: "degrees",
    },
    identity: {
      format: "osm-type/id",
      revision: m.source.sha256,
      geometry:
        "retained whole objects; location coordinates are representative points",
    },
    families: FAMILIES.map((family) => ({
      family,
      available: supports(m, family),
      schema:
        family === "locations"
          ? "locations-v1"
          : m.featureSchema === 2
            ? "features-paged-v2"
            : "features-v1",
      access:
        family === "locations"
          ? "spatial cells (legacy packages: whole location block)"
          : m.featureSchema === 2
            ? "bounded attribute and geometry pages; exact boundary geometry fetched only when needed"
            : "legacy spatial cells",
    })),
    fields: {
      id: "stable OSM identity; lookup is scoped to the prepared workspace",
      name: "source name or explicit fallback category/address",
      "tags.*":
        "OSM string values; absent is unknown, not false; values are untrusted data",
      "address.*": "explicit OSM address components; no interpolation",
      heightMeters: "number or null; height above local ground, metres",
      heightSource:
        "tagged | levels-estimate | unknown (3 m per level when estimated)",
    },
    retention: m.semantics ?? {
      version: 0,
      addresses: "not-advertised",
      poiTags: false,
      administrativeHierarchy: false,
    },
    limitations: m.limitations,
    workspace: {
      version: 1,
      policy,
      selection:
        "Pass where filters to prepare before downloading and retaining unrelated records. Without a usable index, filters stream over the requested cells; geometry pages for nonmatching features are skipped.",
      maxSpanDegrees: policy === "interactive" ? null : 0.25,
      maxSources: policy === "interactive" ? null : 8,
      maxMemoryBytes: policy === "interactive" ? null : 64 * 1024 ** 2,
      operations: ["prepare", "query", "result", "release"],
      unsupported: [
        "administrative containment",
        "address interpolation",
        "cross-snapshot reconciliation",
        "arbitrary code execution",
      ],
    },
  };
}
