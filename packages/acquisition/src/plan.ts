import intersect from "@turf/intersect";
import difference from "@turf/difference";
import type { Feature, Polygon as GeoPolygon, MultiPolygon } from "geojson";
import { planCoverage, type CoverageSource } from "../../coverage/src/index";
import { familySelection } from "../../provisioning/src/families";
import { NO_SIZE_LIMIT } from "../../provisioning/src/capacity";
import {
  availability,
  planPreparation,
  type PackageSelection,
} from "../../provisioning/src/selection";
import { type Block, spatialAddress } from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import { ownsRoutingCell } from "../../format/src/routing-contract";
import { selectedCell, type Polygon } from "../../offline/src/geometry";

export interface AcquisitionRequest {
  name: string;
  polygon: Polygon;
  families: string[];
  minZoom: number;
  maxZoom: number;
  paddingCells: number;
  reference?: string;
  sourceIds: string[];
}
export interface AcquisitionSource extends CoverageSource {
  reader: AtlasReader;
}
export interface AcquisitionPart {
  sourceId: string;
  selection: PackageSelection;
  blocks: Block[];
}
export interface AcquisitionPlan {
  request: AcquisitionRequest;
  coverage: ReturnType<typeof planCoverage>[];
  parts: AcquisitionPart[];
  storedBytes: number;
  localBytes: number;
  remoteBytes: number;
  conflicts: string[];
  incomplete: boolean;
  notes: string[];
}
const shape = (p: Polygon): Feature<GeoPolygon> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[...p, p[0]!]] },
});
const fc = (features: Feature<GeoPolygon | MultiPolygon>[]) => ({
  type: "FeatureCollection" as const,
  features,
});
const supported = (id: string) =>
  /^(tile:(land|water|roads|railways|buildings|peaks)|routing:(walking|cycling|driving)|raster:[a-zA-Z0-9_.-]+|features:[a-z]+)$/.test(
    id,
  ) ||
  [
    "labels",
    "search",
    "addresses",
    "query",
    "features",
    "objects",
    "boundaries",
  ].includes(id);
export function validateAcquisition(request: AcquisitionRequest) {
  if (
    !request ||
    typeof request.name !== "string" ||
    !request.name.trim() ||
    request.name.length > 80 ||
    !Array.isArray(request.families) ||
    !request.families.length ||
    request.families.some((f) => typeof f !== "string" || !supported(f)) ||
    !Array.isArray(request.sourceIds) ||
    request.sourceIds.some((id) => typeof id !== "string") ||
    ![request.minZoom, request.maxZoom, request.paddingCells].every(
      Number.isInteger,
    ) ||
    request.minZoom < 0 ||
    request.maxZoom > 24 ||
    request.minZoom > request.maxZoom ||
    request.paddingCells < 0 ||
    request.paddingCells > 4
  )
    throw Error(
      "Choose a name, supported capabilities, zoom range and 0–4 routing padding cells.",
    );
  planCoverage(
    {
      polygon: request.polygon,
      family: request.families[0]!,
      zoom: request.minZoom,
    },
    [],
  );
}
/** Pure portable selection + dependency planning. No download jobs or server paths. */
export async function planAcquisition(
  request: AcquisitionRequest,
  sources: AcquisitionSource[],
  signal: AbortSignal,
  report = (_: string) => {},
): Promise<AcquisitionPlan> {
  validateAcquisition(request);
  const selected = sources.filter((s) => request.sourceIds.includes(s.id));
  if (selected.length !== new Set(request.sourceIds).size)
    throw Error("A selected source is no longer available; refresh coverage.");
  const coverage = request.families.flatMap((family) => {
    const zooms = /^(tile:|raster:)/.test(family)
      ? Array.from(
          { length: request.maxZoom - request.minZoom + 1 },
          (_, i) => i + request.minZoom,
        )
      : [request.minZoom];
    return zooms.map((zoom) =>
      planCoverage(
        {
          polygon: request.polygon,
          family,
          zoom,
          reference: request.reference,
        },
        selected,
      ),
    );
  });
  const familiesBySource = new Map<string, Set<string>>();
  // Prefer local providers, then remote. Skip wholly redundant coverage. Preserve
  // native source outlines for partially overlapping providers (no invented seams).
  for (const c of coverage) {
    let remaining: Feature<GeoPolygon | MultiPolygon> | null = shape(
      request.polygon,
    );
    const providers = c.providers
      .filter((p) => p.state === "local" || p.state === "remote")
      .sort(
        (a, b) => Number(a.state === "remote") - Number(b.state === "remote"),
      );
    for (const provider of providers) {
      if (!remaining) break;
      const s = selected.find((s) => s.id === provider.id)!;
      const one = planCoverage({ ...c.request, reference: undefined }, [s]);
      const region = one.regions.features.find(
        (f) => f.properties.state === s.location,
      );
      if (!region || !intersect(fc([remaining, region]))) continue;
      const families = familiesBySource.get(s.id) ?? new Set<string>();
      families.add(c.request.family);
      familiesBySource.set(s.id, families);
      remaining = difference(fc([remaining, region]));
    }
  }
  const parts: AcquisitionPart[] = [];
  for (const [id, set] of familiesBySource) {
    signal.throwIfAborted();
    const source = selected.find((s) => s.id === id)!,
      m = source.manifest;
    const families = [...set].map((f) =>
      f === "addresses" ? "search" : f === "query" ? "peaks" : f,
    );
    const s = familySelection(
      m,
      families,
      request.name,
      NO_SIZE_LIMIT,
      request.paddingCells,
    );
    // Search descriptors include reverse geocoding; only advertise what is present.
    s.search =
      families.includes("search") && m.capabilities.includes("location-search");
    s.reverse =
      families.includes("search") && m.capabilities.includes("reverse-street");
    s.featureKinds = availability(m).featureKinds.filter(
      (k) => s.featureKinds.includes(k) || set.has(`features:${k}`),
    );
    s.minZoom = Math.max(request.minZoom, m.minZoom);
    s.maxZoom = Math.min(request.maxZoom, m.maxZoom);
    // Non-display capabilities are not tied to display zoom levels.
    if (s.minZoom > s.maxZoom) {
      s.minZoom = m.minZoom;
      s.maxZoom = m.maxZoom;
    }
    const clip = intersect(fc([shape(request.polygon), shape(s.polygon)]));
    if (!clip) continue;
    const polygons =
      clip.geometry.type === "Polygon"
        ? [clip.geometry.coordinates]
        : clip.geometry.coordinates;
    for (const rings of polygons) {
      if (rings.length !== 1)
        throw Error(
          "This intersection contains holes. Split the acquisition area into simple polygons.",
        );
      if (parts.length >= 64)
        throw Error(
          "This area needs more than 64 source members. Split it into smaller acquisitions.",
        );
      const selection = { ...s, polygon: rings[0]!.slice(0, -1) as Polygon };
      report(`Planning ${m.name} · ${[...set].join(", ")}…`);
      const p = await planPreparation(source.reader, selection, signal, report);
      parts.push({ sourceId: id, selection, blocks: p.blocks });
    }
  }
  if (!parts.length)
    throw Error(
      "No compatible data is available for the requested area and capabilities.",
    );
  const conflicts: string[] = [];
  // Compare complete owned routing cells, including present-vs-empty. Partial edge
  // cells are not authorities. Native payload hashes must agree across publishers.
  for (const mode of ["walking", "cycling", "driving"] as const) {
    if (!request.families.includes(`routing:${mode}`)) continue;
    const c = coverage.find((c) => c.request.family === `routing:${mode}`)!;
    const candidates = selected.filter((s) =>
      c.providers.some(
        (p) => p.id === s.id && ["local", "remote"].includes(p.state),
      ),
    );
    if (candidates.length < 2) continue;
    report(`Checking ${mode} overlap between ${candidates.length} sources…`);
    const cells = new Map<string, Map<string, string>>();
    for (const s of candidates) {
      const clone = familySelection(
        s.manifest,
        [`routing:${mode}`],
        request.name,
        NO_SIZE_LIMIT,
        request.paddingCells,
      );
      // Parts already cover contributors. Inspect overlap providers too, without fetching payloads.
      const box = s.manifest.bounds;
      const clipped = intersect(
        fc([
          shape(request.polygon),
          shape([
            [box[0], box[1]],
            [box[2], box[1]],
            [box[2], box[3]],
            [box[0], box[3]],
          ]),
        ]),
      );
      if (!clipped) continue;
      const polygons =
        clipped.geometry.type === "Polygon"
          ? [clipped.geometry.coordinates]
          : clipped.geometry.coordinates;
      const entries = new Map<string, string>();
      for (const p of polygons) {
        clone.polygon = p[0]!.slice(0, -1) as Polygon;
        for (const b of (await planPreparation(s.reader, clone, signal, report))
          .blocks)
          entries.set(b.key, b.hash);
      }
      cells.set(s.id, entries);
    }
    const keys = new Set([...cells.values()].flatMap((d) => [...d.keys()]));
    for (const key of keys) {
      signal.throwIfAborted();
      const a = spatialAddress(key)!;
      const hashes = new Set<string>();
      for (const s of candidates) {
        const m = s.manifest;
        if (
          m.transport?.federation &&
          !ownsRoutingCell(m.transport.federation, a.x, a.y)
        )
          continue;
        const b = m.bounds;
        if (
          !selectedCell(
            m.selection?.polygon ?? [
              [b[0], b[1]],
              [b[2], b[1]],
              [b[2], b[3]],
              [b[0], b[3]],
            ],
            a.z,
            a.x,
            a.y,
            m.selection?.routingPaddingCells ?? 0,
          )
        )
          continue;
        hashes.add(cells.get(s.id)?.get(key) ?? "empty");
      }
      if (hashes.size > 1) conflicts.push(key);
    }
  }
  const unique = new Map<string, { length: number; local: boolean }>();
  for (const part of parts)
    for (const b of part.blocks) {
      const local =
        selected.find((s) => s.id === part.sourceId)!.location === "local";
      unique.set(b.hash, {
        length: b.length,
        local: local || !!unique.get(b.hash)?.local,
      });
    }
  const values = [...unique.values()];
  return {
    request,
    coverage,
    parts,
    conflicts,
    storedBytes: values.reduce((n, b) => n + b.length, 0),
    localBytes: values.filter((b) => b.local).reduce((n, b) => n + b.length, 0),
    remoteBytes: values
      .filter((b) => !b.local)
      .reduce((n, b) => n + b.length, 0),
    incomplete: coverage.some(
      (c) =>
        c.totals.missing + c.totals.unknown + c.totals.incompatible >
        Math.max(1, c.areaM2 * 1e-8),
    ),
    notes: [
      "Stored block bytes are exact for this plan; Hashtree chunks and directories add transfer overhead. Planning reads catalogs and legacy inline cells.",
      "Overlapping contributors retain whole cells and objects. Identical blocks are cached by hash; output members preserve their native routing identities.",
      "Search indexes are rebuilt from selected spatial records. Custom families need a registered extraction adapter and are not included by this slice.",
      "Coverage describes retained source data, not real-world completeness. Routes that leave the selected area and padding may still need more data.",
    ],
  };
}
