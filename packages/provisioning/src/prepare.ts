import { selectedPeaks } from "../../format/src/peaks";
import { selectedPlaces } from "../../labels/src/place-pages";
import { rm } from "node:fs/promises";
import { PagedSearchBuilder } from "../../geocoding/src/paged-build";
import { STREET_ZOOM } from "../../geocoding/src/paging";
import { locations, streets } from "../../geocoding/src/index";
import booleanIntersects from "@turf/boolean-intersects";
import type { Polygon as GeoPolygon } from "geojson";
import { DiskWriter } from "../../cli/src/disk-writer";
import {
  project,
  type Manifest,
  type Peak,
  type TransportMetadata,
} from "../../format/src/index";
import { AtlasReader } from "../../format/src/reader";
import { splitTile, tileRecords } from "../../format/src/tiles";
import { type MapFeature } from "../../features/src/index";
import { readFeatureCell } from "../../features/src/pages";
import { PagedFeatureWriter } from "../../features/src/paged-build";
import { decodeLabels } from "../../labels/src/index";
import { decodePlaces, encodePlaces } from "../../labels/src/places";
import type { Position } from "../../geocoding/src/model";
import {
  bounds,
  inside,
  clipSegment,
  interpolate,
  type Polygon,
} from "../../offline/src/geometry";
import {
  planPreparation,
  type PackageSelection,
  type PreparationProgress,
} from "./selection";
export function clipLine(line: Position[], polygon: Polygon): Position[][] {
  const parts: Position[][] = [];
  let part: Position[] | undefined;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!,
      b = line[i]!,
      intervals = clipSegment(a, b, polygon);
    if (!intervals.length) part = undefined;
    for (const [lo, hi] of intervals) {
      const start = interpolate(a, b, lo),
        end = interpolate(a, b, hi),
        last = part?.at(-1);
      if (
        part &&
        last &&
        Math.hypot(last[0] - start[0], last[1] - start[1]) < 1e-12
      )
        part.push(end);
      else {
        part = [start, end];
        parts.push(part);
      }
      if (hi < 1) part = undefined;
    }
  }
  return parts;
}
export async function preparePackage(
  reader: AtlasReader,
  s: PackageSelection,
  output: string,
  signal: AbortSignal,
  report: (p: PreparationProgress) => void,
) {
  const p: PreparationProgress = {
    phase: "planning",
    message: "Reading directory pages…",
    completed: 0,
    total: 0,
    readBytes: 0,
    writtenBytes: 0,
  };
  const emit = (message: string) => {
    p.message = message;
    p.readBytes = reader.bytesRead;
    report({ ...p });
  };
  const plan = await planPreparation(reader, s, signal, emit),
    m = reader.index.manifest;
  p.total = plan.blocks.length;
  p.phase = "packing";
  const writer = await new DiskWriter(output, s.maxBytes).open(),
    encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const featureWriter = new PagedFeatureWriter(writer);
  const region: GeoPolygon = {
    type: "Polygon",
    coordinates: [[...s.polygon, s.polygon[0]!]],
  };
  const profiles: TransportMetadata["profiles"] = {},
    heights = { tagged: 0, estimated: 0, missing: 0, maxMeters: 0 };
  for (const mode of s.profiles)
    profiles[mode] = {
      ...m.transport!.profiles[mode]!,
      count: 0,
      nodes: 0,
      segments: 0,
      turns: 0,
    };
  let peakCount = 0;
  let search: PagedSearchBuilder | undefined;
  const searchPath = output + ".search.sqlite";
  const rebuildSearch = async (
    kind: "locations" | "streets",
    rootBytes: Uint8Array,
  ) => {
    if (!search) {
      await rm(searchPath, { force: true });
      await rm(searchPath + "-journal", { force: true });
      search = new PagedSearchBuilder(searchPath);
    }
    const root = JSON.parse(new TextDecoder().decode(rootBytes));
    const box = bounds(s.polygon),
      n = 2 ** STREET_ZOOM;
    const nw = project(box[0], box[3]),
      se = project(box[2], box[1]);
    const pages =
      root.schema === `${kind}-paged-v1`
        ? await reader.spatial(
            `search/${kind}-data`,
            STREET_ZOOM,
            Math.max(0, Math.floor(nw[0] * n)),
            Math.min(n - 1, Math.floor(se[0] * n)),
            Math.max(0, Math.floor(nw[1] * n)),
            Math.min(n - 1, Math.floor(se[1] * n)),
          )
        : [{ key: `search/${kind}` }];
    for (const page of pages) {
      signal.throwIfAborted();
      const bytes =
        page.key === `search/${kind}`
          ? rootBytes
          : await reader.block(page.key);
      if (kind === "locations") {
        for (const { record } of locations(bytes))
          if (inside(record.coordinates, s.polygon)) search.addLocation(record);
      } else {
        // The disk-backed primary key deduplicates streets repeated in adjacent cells.
        for (const { street } of streets(bytes))
          for (const coordinates of clipLine(street.coordinates, s.polygon))
            search.addStreet({ ...street, coordinates });
      }
      reader.cache.delete(page.key);
      emit(`Selecting ${page.key}`);
    }
  };
  try {
    for (const b of plan.blocks) {
      signal.throwIfAborted();
      if (/^features\/(attributes|geometry)\//.test(b.key)) {
        p.completed++;
        continue;
      }
      emit(`Packing ${b.key}`);
      const bytes = await reader.block(b.key);
      signal.throwIfAborted();
      let outputBytes = bytes,
        features = b.features,
        keep = true;
      if (b.key.startsWith("tile/")) {
        for (const record of tileRecords(bytes))
          if (record.class === 2) {
            const h = record.height;
            heights[
              h && (h.source & 3) === 1
                ? "tagged"
                : h && (h.source & 3) === 2
                  ? "estimated"
                  : "missing"
            ]++;
            heights.maxMeters = Math.max(
              heights.maxMeters,
              h?.height ?? 0,
              h?.minHeight ?? 0,
            );
          }
        if (!m.tileLayers) {
          for (const part of splitTile(bytes))
            if (s.layers.includes(part.layer))
              await writer.add({
                key: `tile/${part.layer}/${b.z}/${b.x}/${b.y}`,
                bytes: part.bytes,
                z: b.z,
                x: b.x,
                y: b.y,
                features: part.features,
              });
          keep = false;
        }
      } else if (b.key === "labels/places") {
        const values = await selectedPlaces(reader, s.polygon);
        outputBytes = encodePlaces(values);
        features = values.length;
        keep = !!features;
      } else if (b.key.startsWith("labels/")) {
        const data = decodeLabels(bytes);
        data.pois = s.pois
          ? data.pois.filter((v) => inside(v.coordinates, s.polygon))
          : [];
        data.roads = s.streetNames
          ? data.roads.flatMap((v) =>
              clipLine(v.coordinates, s.polygon).map((coordinates) => ({
                ...v,
                coordinates,
              })),
            )
          : [];
        features = data.pois.length + data.roads.length;
        outputBytes = encode(data);
        keep = !!features;
      } else if (b.key.startsWith("features/")) {
        if (!/^features\/(attributes|geometry)\//.test(b.key)) {
          async function* selectedFeatures() {
            for await (const f of readFeatureCell(
              reader,
              b.key,
              bounds(s.polygon),
              true,
              signal,
            ))
              if (booleanIntersects(f.geometry!, region)) yield f as MapFeature;
          }
          await featureWriter.cell(b.key, selectedFeatures(), signal);
        }
        keep = false;
      } else if (b.key === "search/locations" || b.key === "search/streets") {
        await rebuildSearch(
          b.key === "search/locations" ? "locations" : "streets",
          bytes,
        );
        keep = false;
      } else if (b.key === "query/peaks") {
        const values = await selectedPeaks(reader, s.polygon);
        peakCount = features = values.length;
        outputBytes = encode(values);
      } else if (b.key.startsWith("routing/")) {
        const mode = s.profiles.find((mode) =>
          b.key.startsWith(profiles[mode]!.prefix + "/"),
        )!;
        const profile = profiles[mode]!,
          v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "RCL2")
          throw new Error("Expected RCL2 transport cells");
        profile.count++;
        profile.nodes += v.getUint32(20, true);
        profile.segments += v.getUint32(24, true);
        profile.turns += v.getUint32(28, true);
      }
      if (keep)
        await writer.add({
          key: b.key,
          bytes: outputBytes,
          features,
          ...(b.z === undefined ? {} : { z: b.z, x: b.x, y: b.y }),
        });
      reader.cache.delete(b.key);
      p.completed++;
      p.writtenBytes = writer.bytesWritten;
    }
    signal.throwIfAborted();
    if (search)
      await search.finish(
        writer,
        { search: s.search, reverse: s.reverse },
        signal,
        emit,
      );
    const keys = new Set(writer.blocks.map((b) => b.key)),
      caps: string[] = [],
      layers = s.layers.filter((l) =>
        writer.blocks.some((b) => b.key.startsWith(`tile/${l}/`)),
      ),
      featureKinds = s.featureKinds.filter((k) =>
        writer.blocks.some((b) => b.key.startsWith(`features/${k}/`)),
      );
    if (layers.length) caps.push("vector-rendering");
    if (layers.includes("buildings") && m.buildingHeights)
      caps.push("building-heights");
    if ([...keys].some((k) => k.startsWith("labels/"))) caps.push("map-labels");
    if (keys.has("search/locations")) {
      caps.push("location-search");
      if (m.semantics) caps.push("semantic-locations");
      if (m.semantics?.addresses === "osm-explicit")
        caps.push("address-search");
    }
    if (keys.has("search/streets")) caps.push("reverse-street");
    if (keys.has("query/peaks")) caps.push("peak-query");
    if (featureKinds.length) caps.push("feature-extraction");
    for (const mode of s.profiles)
      if (!profiles[mode]!.count) delete profiles[mode];
    if (Object.keys(profiles).length) caps.push("transport-routing");
    const manifest: Omit<Manifest, "snapshot"> = {
      ...m,
      name: s.name.trim(),
      bounds: bounds(s.polygon),
      minZoom: s.minZoom,
      maxZoom: s.maxZoom,
      features: writer.blocks
        .filter((b) => b.key.startsWith("tile/"))
        .reduce((n, b) => n + b.features, 0),
      featureCountKind: "tile-records",
      peaks: peakCount,
      places: s.placeNames
        ? m.places.filter((v) => inside(v.coordinates, s.polygon))
        : [],
      tileLayers: layers,
      featureKinds,
      featureZoom: featureKinds.length ? m.featureZoom : undefined,
      featureSchema: featureKinds.length ? 2 : undefined,
      labelZoom: caps.includes("map-labels") ? m.labelZoom : undefined,
      buildingHeights: caps.includes("building-heights") ? heights : undefined,
      routing: undefined,
      transport: caps.includes("transport-routing")
        ? {
            version: 1,
            profiles,
            statistics: "cell-records",
            graphSnapshot: m.transport!.graphSnapshot ?? m.snapshot,
          }
        : undefined,
      capabilities: caps,
      semantics: s.search ? m.semantics : undefined,
      selection: {
        polygon: s.polygon,
        parentSnapshot: m.snapshot,
        boundaryPolicy:
          "intersecting-display-tiles; intersecting-source-objects; clipped-labels-and-search; padded-whole-routing-cells",
        ...(caps.includes("transport-routing")
          ? { routingPaddingCells: s.paddingCells }
          : {}),
      },
      limitations: [
        ...m.limitations,
        "Host excerpt: display tiles and whole source objects may extend outside the polygon. Routing uses whole cells with padding; a search leaving included coverage reports missing data. Transport counts sum cell records, including duplicates.",
      ],
    };
    delete (manifest as Partial<Manifest>).snapshot;
    if (!writer.blocks.length)
      throw new Error("No objects remain inside this selection.");
    p.phase = "indexing";
    emit("Writing the package directory and publishing the file…");
    const size = await writer.finish(manifest);
    signal.throwIfAborted();
    p.writtenBytes = size;
    return { size, manifest };
  } catch (e) {
    await writer.abort();
    throw e;
  } finally {
    await search?.dispose();
  }
}
