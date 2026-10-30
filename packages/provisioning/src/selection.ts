import { readSearchCell } from "../../geocoding/src/cell-pages";
import { objectRecords } from "../../objects/src/index";
import {
  boundaryCatalog,
  boundaryRecords,
  BOUNDARY_ROOT,
} from "../../boundaries/src/index";
import { featureCatalog, featureBlock } from "../../features/src/pages";
import { validBudget } from "./capacity";
import {
  MAP_LAYERS,
  TRANSPORT_MODES,
  project,
  spatialAddress,
  type Block,
  type Manifest,
  type MapLayer,
  type TransportMode,
} from "../../format/src/index";
import { FEATURE_KINDS, type FeatureKind } from "../../features/src/index";
import type { AtlasReader } from "../../format/src/reader";
import {
  bounds,
  selectedCell,
  intersectsRectangle,
  validatePolygon,
  type Polygon,
} from "../../offline/src/geometry";
export interface PackageSelection {
  /** Optional, pinned server-configured assembled ocean source. */
  ocean?: { sha256: string };
  /** Intersecting raster tiles; pixels remain unchanged. */
  rasters?: string[];
  snapshot: string;
  name: string;
  polygon: Polygon;
  minZoom: number;
  maxZoom: number;
  layers: MapLayer[];
  placeNames: boolean;
  streetNames: boolean;
  pois: boolean;
  profiles: TransportMode[];
  search: boolean;
  reverse: boolean;
  peaks: boolean;
  featureKinds: FeatureKind[];
  paddingCells: number;
  maxBytes: number;
}
export interface PreparationProgress {
  phase:
    | "planning"
    | "downloading"
    | "extracting"
    | "compiling"
    | "packing"
    | "indexing"
    | "verifying";
  unit?:
    | "blocks"
    | "bytes"
    | "stages"
    | "ways"
    | "cells"
    | "objects"
    | "records"
    | "terms";
  stage?: string;
  stageIndex?: number;
  stageCount?: number;
  elapsedSeconds?: number;
  etaSeconds?: number;
  checkpointAt?: string;
  stagePercent?: number;
  message: string;
  completed: number;
  total: number;
  readBytes: number;
  writtenBytes: number;
}
export function availability(m: Manifest) {
  return {
    layers: m.capabilities.includes("vector-rendering")
      ? (m.tileLayers ?? [...MAP_LAYERS])
      : [],
    profiles: TRANSPORT_MODES.filter((p) => !!m.transport?.profiles[p]),
    featureKinds: m.capabilities.includes("feature-extraction")
      ? (m.featureKinds ??
        FEATURE_KINDS.filter((k) => k !== "boundaries" && k !== "objects"))
      : [],
    labels: m.capabilities.includes("map-labels"),
    search: m.capabilities.includes("location-search"),
    reverse: m.capabilities.includes("reverse-street"),
    peaks: m.capabilities.includes("peak-query"),
  };
}
export interface SelectionScope {
  snapshot: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  available: ReturnType<typeof availability>;
}
export function validateSelection(
  value: unknown,
  m: Manifest,
): asserts value is PackageSelection {
  const selected = value as PackageSelection;
  if (
    selected?.rasters &&
    (!Array.isArray(selected.rasters) ||
      selected.rasters.some((id) => !m.rasters?.some((r) => r.id === id)))
  )
    throw new Error("Selected raster is unavailable");
  validateSelectionScope(value, {
    snapshot: m.snapshot,
    bounds: m.bounds,
    minZoom: m.minZoom,
    maxZoom: m.maxZoom,
    available: availability(m),
  });
}
export function validateSelectionScope(
  value: unknown,
  m: SelectionScope,
): asserts value is PackageSelection {
  if (!value || typeof value !== "object")
    throw new Error("Invalid package selection");
  const s = value as PackageSelection;
  if (
    s.ocean !== undefined &&
    (!s.ocean || !/^[a-f0-9]{64}$/.test(s.ocean.sha256))
  )
    throw new Error("Invalid ocean source fingerprint");
  if (s.snapshot !== m.snapshot)
    throw new Error("Source snapshot changed. Reload the host console.");
  if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 80)
    throw new Error("Give the package a name of 1–80 characters.");
  if (!Array.isArray(s.polygon)) throw new Error("Draw an area first.");
  validatePolygon(s.polygon);
  if (!intersectsRectangle(s.polygon, m.bounds))
    throw new Error("Selection does not intersect the source map.");
  if (
    s.polygon.some(
      ([x, y]) =>
        x < m.bounds[0] ||
        x > m.bounds[2] ||
        y < m.bounds[1] ||
        y > m.bounds[3],
    )
  )
    throw new Error("Keep all corners inside the source map bounds.");
  if (
    ![s.minZoom, s.maxZoom].every(Number.isInteger) ||
    s.minZoom < m.minZoom ||
    s.maxZoom > m.maxZoom ||
    s.minZoom > s.maxZoom
  )
    throw new Error("Choose a zoom range within the source package.");
  const a = m.available;
  const subset = (v: unknown, all: readonly string[]) =>
    Array.isArray(v) &&
    v.every((x) => typeof x === "string" && all.includes(x)) &&
    new Set(v).size === v.length;
  if (
    !subset(s.layers, a.layers) ||
    !subset(s.profiles, a.profiles) ||
    !subset(s.featureKinds, a.featureKinds)
  )
    throw new Error(
      "A selected layer, feature category or travel mode is not available.",
    );
  for (const k of [
    "placeNames",
    "streetNames",
    "pois",
    "search",
    "reverse",
    "peaks",
  ] as const)
    if (typeof s[k] !== "boolean") throw new Error(`Invalid ${k} selection`);
  if (
    ((s.placeNames || s.streetNames || s.pois) && !a.labels) ||
    (s.search && !a.search) ||
    (s.reverse && !a.reverse) ||
    (s.peaks && !a.peaks)
  )
    throw new Error("A selected capability is absent from this source.");
  if (
    !Number.isInteger(s.paddingCells) ||
    s.paddingCells < 0 ||
    s.paddingCells > 4
  )
    throw new Error("Routing padding must be 0–4 cells.");
  if (!validBudget(s.maxBytes))
    throw new Error(
      "Enter an output budget of at least 1 MiB, with an exact whole-byte value.",
    );
  if (
    !s.rasters?.length &&
    !s.layers.length &&
    !s.profiles.length &&
    !s.featureKinds.length &&
    !s.placeNames &&
    !s.streetNames &&
    !s.pois &&
    !s.search &&
    !s.reverse &&
    !s.peaks
  )
    throw new Error("Select at least one data capability.");
}
export async function planPreparation(
  reader: AtlasReader,
  s: PackageSelection,
  signal = new AbortController().signal,
  report = (_: string) => {},
) {
  validateSelection(s, reader.index.manifest);
  const m = reader.index.manifest,
    box = bounds(s.polygon),
    nw = project(box[0], box[3]),
    se = project(box[2], box[1]),
    chosen = new Map<string, Block>();
  const add = (blocks: Block[]) => {
    for (const b of blocks) chosen.set(b.key, b);
  };
  async function spatial(
    prefix: string,
    z: number,
    padding = 0,
    rectangle = false,
  ) {
    signal.throwIfAborted();
    const n = 2 ** z;
    return (
      await reader.spatial(
        prefix,
        z,
        Math.max(0, Math.floor(nw[0] * n) - padding),
        Math.min(n - 1, Math.floor(se[0] * n) + padding),
        Math.max(0, Math.floor(nw[1] * n) - padding),
        Math.min(n - 1, Math.floor(se[1] * n) + padding),
      )
    ).filter((b) => {
      const a = spatialAddress(b.key)!;
      return rectangle || selectedCell(s.polygon, z, a.x, a.y, padding);
    });
  }
  for (let z = s.minZoom; z <= s.maxZoom; z++) {
    report(`Finding selected map layers at z${z}…`);
    for (const prefix of m.tileLayers
      ? s.layers.map((l) => `tile/${l}`)
      : s.layers.length
        ? ["tile"]
        : [])
      add(await spatial(prefix, z));
  }
  for (const id of s.rasters ?? []) {
    const raster = m.rasters!.find((r) => r.id === id)!;
    for (
      let z = Math.max(s.minZoom, raster.minZoom);
      z <= Math.min(s.maxZoom, raster.maxZoom);
      z++
    )
      add(await spatial(`raster/${id}`, z));
  }
  for (const kind of s.featureKinds) {
    report(`Finding ${kind} source objects…`);
    if (kind === "objects") {
      const keep = async (key: string) => {
        const block = await featureBlock(reader, key);
        if (!block) throw new Error(`Missing source object block ${key}`);
        add([block]);
      };
      for await (const row of objectRecords(
        reader,
        { bounds: box, includeDependencies: true, includeUnlocated: true },
        signal,
        report,
        keep,
      )) {
        for (const key of [
          ...(row.geometry?.blocks ?? []),
          ...(row.topology?.blocks ?? []),
        ])
          await keep(key);
      }
      continue;
    }
    if (kind === "boundaries") {
      const catalog = await boundaryCatalog(reader);
      for (const key of [BOUNDARY_ROOT, ...catalog.pages.map((p) => p.key)]) {
        const block = await featureBlock(reader, key);
        if (!block) throw new Error(`Missing boundary block ${key}`);
        add([block]);
      }
      for await (const record of boundaryRecords(
        reader,
        bounds(s.polygon),
        signal,
        report,
      )) {
        const block = await featureBlock(reader, record.geometry);
        if (!block)
          throw new Error(`Missing boundary geometry ${record.geometry}`);
        add([block]);
      }
      continue;
    }
    const cells = await spatial(`features/${kind}`, m.featureZoom!);
    add(cells);
    if (m.featureSchema === 2)
      for (const cell of cells) {
        signal.throwIfAborted();
        const catalog = featureCatalog(await reader.block(cell.key));
        if (!catalog) throw new Error("Expected paged features");
        for (const p of catalog.pages)
          for (const key of [p.attributes, p.geometry]) {
            const block = await featureBlock(reader, key);
            if (!block) throw new Error(`Missing feature page ${key}`);
            add([block]);
          }
      }
  }
  for (const mode of s.profiles) {
    const p = m.transport!.profiles[mode]!;
    report(`Finding ${mode} graph cells…`);
    add(await spatial(p.prefix, p.zoom, s.paddingCells));
  }
  if (m.labelZoom !== undefined)
    for (const family of ["roads", "pois"] as const) {
      if (family === "roads" ? !s.streetNames : !s.pois) continue;
      for (const tier of [13, 14, 15, 16, 17])
        add(await spatial(`labels/${family}/${tier}`, m.labelZoom));
    }
  for (const b of reader.index.blocks) {
    if (b.key === "labels/places") {
      if (s.placeNames) add([b]);
      continue;
    }
    if (b.key.startsWith("labels/")) {
      const [, z, x, y, family] = b.key.split("/");
      if (
        (family === "roads" && !s.streetNames) ||
        (family === "pois" && !s.pois) ||
        (!family && !s.streetNames && !s.pois)
      )
        continue;
      if (selectedCell(s.polygon, +z!, +x!, +y!)) add([b]);
    }
    if (
      (s.search && b.key === "search/locations") ||
      (s.reverse && b.key === "search/streets") ||
      (s.peaks && b.key === "query/peaks")
    )
      add([b]);
  }
  // Dependency closure for the excerpt builders. Search needs spatial records,
  // not the source's global term/posting indexes: those are rebuilt in the output.
  for (const kind of ["locations", "streets"] as const) {
    if (kind === "locations" ? !s.search : !s.reverse) continue;
    const key = `search/${kind}`;
    const root = JSON.parse(new TextDecoder().decode(await reader.block(key)));
    if (root.schema !== `${kind}-paged-v1`) continue;
    const cells = await spatial(`search/${kind}-data`, 14, 0, true);
    for (const cell of cells) {
      report(`Planning ${cell.key} and its record pages…`);
      for await (const _ of readSearchCell(
        reader,
        cell.key,
        kind,
        box,
        signal,
        async (key) => {
          const block = await featureBlock(reader, key);
          if (!block) throw Error(`Missing search dependency ${key}`);
          add([block]);
        },
        true,
      )) {
        /* validation and dependency discovery share the reader's schema checks */
      }
    }
  }
  if (s.placeNames && chosen.has("labels/places")) {
    const root = JSON.parse(
      new TextDecoder().decode(await reader.block("labels/places")),
    );
    if (root.schema === "places-paged-v1")
      add(await spatial("labels/settlements", 8, 0, true));
  }
  if (s.peaks && chosen.has("query/peaks")) {
    const root = JSON.parse(
      new TextDecoder().decode(await reader.block("query/peaks")),
    );
    if (root.schema === "peaks-paged-v1")
      add(await spatial("query/peaks-data", 8, 0, true));
  }
  signal.throwIfAborted();
  const blocks = [...chosen.values()].sort((a, b) => a.offset - b.offset);
  if (!blocks.length && !s.profiles.length)
    throw new Error("No selected data intersects this area.");
  const families: Record<string, { blocks: number; bytes: number }> = {};
  for (const b of blocks) {
    const key = b.key.startsWith("tile/")
      ? "Map geometry"
      : b.key.startsWith("routing/")
        ? "Routing & isochrones"
        : b.key.startsWith("features/")
          ? "Source features"
          : b.key.startsWith("labels/")
            ? "Labels"
            : b.key.startsWith("search/")
              ? "Search & geocoding"
              : "Peak queries";
    const f = (families[key] ??= { blocks: 0, bytes: 0 });
    f.blocks++;
    f.bytes += b.length;
  }
  return {
    blocks,
    sourceBytes: blocks.reduce((n, b) => n + b.length, 0),
    families,
  };
}
