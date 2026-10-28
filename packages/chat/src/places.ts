import { findBoundary, hasBoundaries } from "../../boundaries/src/index";
import type { Feature, FeatureCollection } from "geojson";
import type { AtlasReader } from "../../format/src/reader";
import { project } from "../../format/src/index";
import { geometryBounds, type Bounds } from "../../features/src/index";
import { readFeatureCell } from "../../features/src/pages";
import { canonical } from "./recipes";

/** Search anchors are retained source positions, not a model-selected study radius. */
export async function placeGeometry(
  readers: AtlasReader[],
  chosen: Feature,
  family: "land" | "water" | "buildings" | "boundaries",
  signal: AbortSignal,
  progress: (text: string) => void = () => {},
) {
  if (
    !["land", "water", "buildings", "boundaries"].includes(family) ||
    chosen.geometry.type !== "Point"
  )
    throw new Error("Choose a point search candidate and a polygon family");
  const [lon, lat] = chosen.geometry.coordinates as [number, number];
  const seed: Bounds = [lon - 1e-7, lat - 1e-7, lon + 1e-7, lat + 1e-7];
  const snapshots: string[] = [],
    omittedSources: string[] = [];
  let feature: Feature | undefined;
  for (const reader of readers) {
    signal.throwIfAborted();
    const m = reader.index.manifest;
    if (!m.featureKinds?.includes(family) || m.featureZoom === undefined) {
      omittedSources.push(m.snapshot);
      continue;
    }
    progress(
      `Finding ${chosen.properties?.name ?? chosen.id} footprint in ${m.name}`,
    );
    if (family === "boundaries") {
      if (!hasBoundaries(reader)) {
        omittedSources.push(m.snapshot);
        continue;
      }
      const found = await findBoundary(reader, String(chosen.id), signal);
      if (found) {
        if (
          feature &&
          canonical(feature.geometry) !== canonical(found.geometry)
        )
          throw new Error(
            "Selected sources disagree on the administrative boundary",
          );
        feature = found;
        snapshots.push(m.snapshot);
      }
      continue;
    }
    const n = 2 ** m.featureZoom,
      nw = project(seed[0], seed[3]),
      se = project(seed[2], seed[1]);
    const cells = await reader.spatial(
      `features/${family}`,
      m.featureZoom,
      Math.floor(nw[0] * n),
      Math.floor(se[0] * n),
      Math.floor(nw[1] * n),
      Math.floor(se[1] * n),
    );
    for (const cell of cells) {
      // Exact-ID lookup also handles anchors inside a polygon hole.
      for await (const row of readFeatureCell(
        reader,
        cell.key,
        seed,
        true,
        signal,
        undefined,
        String(chosen.id),
      )) {
        if (row.id !== chosen.id || !row.geometry) continue;
        if (
          row.geometry.type !== "Polygon" &&
          row.geometry.type !== "MultiPolygon"
        )
          continue;
        if (feature && canonical(feature.geometry) !== canonical(row.geometry))
          throw new Error(
            "Selected sources disagree on the named place boundary",
          );
        feature = {
          type: "Feature",
          id: row.id,
          properties: row.properties,
          geometry: row.geometry,
          bbox: geometryBounds(row.geometry),
        };
        snapshots.push(m.snapshot);
      }
    }
  }
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: feature ? [feature] : [],
  };
  return {
    collection,
    meta: {
      name: chosen.properties?.name,
      family,
      snapshots: [...new Set(snapshots)],
      omittedSources,
      boundaryAvailable: !!feature,
      nextAction: feature
        ? "filter_against_polygon"
        : "ask_user_for_boundary_or_permission_to_approximate",
      realWorldCompleteness: "unknown",
      note: feature
        ? "Full retained source footprint. Bounds are a preparation envelope; filter against the polygon for inside, including holes. Coverage must be checked for the requested data families."
        : "No retained polygon for this exact source ID at its search anchor. This can be a point-only place, unsupported family, or missing coverage. Ask for a boundary or an agreed approximation; do not invent an extent.",
    },
  };
}
