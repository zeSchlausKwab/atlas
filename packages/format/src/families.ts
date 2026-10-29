import type { Manifest } from "./index";
/** Descriptive data contract only. A descriptor never installs or executes code. */
export interface DataFamily {
  id: string;
  version: 1;
  schema: { id: string; version: number };
  encoding: string;
  blockPrefix: string;
  coverage: {
    bounds: [number, number, number, number];
    minZoom?: number;
    maxZoom?: number;
  };
  provenance: {
    url: string;
    fingerprint?: string;
    attribution: string;
    license?: string;
  };
  dependencies: Array<{ id: string; fingerprint: string }>;
}
const key = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;
export function validateFamilies(
  value: unknown,
): asserts value is DataFamily[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid family catalog");
  const ids = new Set<string>(),
    prefixes: string[] = [];
  for (const f of value) {
    const b = f?.coverage?.bounds,
      p = f?.provenance;
    if (
      !f ||
      f.version !== 1 ||
      typeof f.id !== "string" ||
      !key.test(f.id) ||
      ids.has(f.id) ||
      !f.schema ||
      typeof f.schema.id !== "string" ||
      !key.test(f.schema.id) ||
      !Number.isInteger(f.schema.version) ||
      f.schema.version < 1 ||
      typeof f.encoding !== "string" ||
      !f.encoding ||
      typeof f.blockPrefix !== "string" ||
      !key.test(f.blockPrefix) ||
      !f.blockPrefix.endsWith("/") ||
      f.blockPrefix.includes("..") ||
      prefixes.some(
        (s) => s.startsWith(f.blockPrefix) || f.blockPrefix.startsWith(s),
      ) ||
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every(Number.isFinite) ||
      b[0] < -180 ||
      b[2] > 180 ||
      b[1] < -90 ||
      b[3] > 90 ||
      b[0] >= b[2] ||
      b[1] >= b[3] ||
      !p ||
      typeof p.url !== "string" ||
      !p.url ||
      typeof p.attribution !== "string" ||
      (p.license !== undefined && typeof p.license !== "string") ||
      (p.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(p.fingerprint)) ||
      !Array.isArray(f.dependencies) ||
      f.dependencies.some(
        (d: DataFamily["dependencies"][number]) =>
          !d ||
          typeof d.id !== "string" ||
          !key.test(d.id) ||
          !/^[a-f0-9]{64}$/.test(d.fingerprint),
      )
    )
      throw new Error("Invalid family descriptor");
    const { minZoom, maxZoom } = f.coverage;
    if (
      (minZoom !== undefined || maxZoom !== undefined) &&
      (!Number.isInteger(minZoom) ||
        !Number.isInteger(maxZoom) ||
        minZoom < 0 ||
        maxZoom > 24 ||
        minZoom > maxZoom)
    )
      throw new Error("Invalid family zoom coverage");
    ids.add(f.id);
    prefixes.push(f.blockPrefix);
  }
}
const builtIn = (id: string) =>
  /^(raster:|tile:|routing:)/.test(id) ||
  ["labels", "search", "features", "boundaries", "objects", "query"].includes(
    id,
  );
/** Adapts old archives; rebuilds known descriptors from authoritative family metadata. */
export function familyCatalog(m: Omit<Manifest, "snapshot">): DataFamily[] {
  const result: DataFamily[] = (m.families ?? []).filter((f) => !builtIn(f.id));
  const add = (
    id: string,
    blockPrefix: string,
    encoding: string,
    schemaVersion = 1,
    fingerprint = m.source.sha256,
  ) =>
    result.push({
      id,
      version: 1,
      schema: { id: `atlas/${id.split(":")[0]}`, version: schemaVersion },
      encoding,
      blockPrefix,
      coverage: { bounds: [...m.bounds] },
      provenance: {
        url: m.source.url,
        attribution: m.source.attribution,
        fingerprint,
      },
      dependencies: [],
    });
  if (!m.tileLayers && m.capabilities.includes("vector-rendering"))
    add("tile:legacy", "tile/", "atlas-vector");
  for (const l of m.tileLayers ?? []) {
    add(`tile:${l}`, `tile/${l}/`, "atlas-vector");
    Object.assign(result.at(-1)!.coverage, {
      minZoom: m.minZoom,
      maxZoom: m.maxZoom,
    });
  }
  if (m.capabilities.includes("map-labels"))
    add("labels", "labels/", "atlas-labels");
  if (
    m.capabilities.some((c) =>
      ["location-search", "reverse-street"].includes(c),
    )
  )
    add("search", "search/", "atlas-search");
  if (m.capabilities.includes("peak-query"))
    add("query", "query/", "atlas-query");
  for (const family of ["features", "objects", "boundaries"])
    if (
      family === "features"
        ? m.featureKinds?.some((k) => k !== "objects" && k !== "boundaries")
        : m.featureKinds?.includes(family as "objects" | "boundaries")
    )
      add(family, `${family}/`, "atlas-feature-pages", m.featureSchema ?? 1);
  if (!m.transport && m.routing)
    add("routing:legacy-walking", "routing/", m.routing.cells?.codec ?? "rte1");
  if (!m.featureKinds && m.featureZoom !== undefined)
    add("features", "features/", "atlas-feature-pages", m.featureSchema ?? 1);
  for (const [mode] of Object.entries(m.transport?.profiles ?? {}))
    add(
      `routing:${mode}`,
      `routing/${mode}/`,
      "rcl2",
      2,
      m.transport?.graphSnapshot ?? m.source.sha256,
    );
  for (const r of m.rasters ?? [])
    result.push({
      id: `raster:${r.id}`,
      version: 1,
      schema: { id: "atlas/raster", version: r.version },
      encoding: `${r.encoding}-${r.tileSize}-xyz`,
      blockPrefix: `raster/${r.id}/`,
      coverage: {
        bounds: [...r.bounds],
        minZoom: r.minZoom,
        maxZoom: r.maxZoom,
      },
      provenance: {
        ...r.source,
        fingerprint: r.registration?.sha256 ?? r.provenance?.archiveSnapshot,
      },
      dependencies: [],
    });
  validateFamilies(result);
  return result;
}
