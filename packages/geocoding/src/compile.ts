import { areaAnchor } from "./anchor";
import type { FeatureCollection } from "geojson";
import {
  type Location,
  type LocationBlock,
  type Street,
  type StreetBlock,
  type Position,
  validPosition,
  meters,
  nearestOnLine,
  normalize,
  enrichLocation,
  explicitAddress,
  addressText,
} from "./model";
const STREET_TYPES = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "pedestrian",
  "road",
  "track",
]);
function aliases(tags: Record<string, string>, name: string) {
  return [
    ...new Set(
      [tags.alt_name, tags.short_name, tags["name:de"], tags["name:en"]]
        .filter(Boolean)
        .flatMap((s) => s!.split(";"))
        .map((s) => s.trim())
        .filter((s) => s && s !== name),
    ),
  ];
}
function midpoint(line: Position[]): Position {
  const lengths = line.slice(1).map((p, i) => meters(line[i]!, p));
  let rest = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (rest <= len) {
      const t = len === 0 ? 0 : rest / len,
        a = line[i]!,
        b = line[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    rest -= len;
  }
  return line[0]!;
}
export function buildGeocoding(
  nodes: Location[],
  features: FeatureCollection,
  options: {
    nearby?: (point: Position) => Location | undefined;
    group?: (key: string, record: Location, distance: number) => void;
  } = {},
): { locations: LocationBlock; streets: StreetBlock } {
  const records = nodes
    .filter((n) => validPosition(n.coordinates))
    .map((n) => enrichLocation({ ...n, aliases: [...n.aliases] }));
  const places = records.filter(
    (n) =>
      n.kind === "place" &&
      ["city", "town", "village", "hamlet"].includes(n.category),
  );
  const nearby =
    options.nearby ??
    function nearby(point: Position) {
      let best: Location | undefined,
        dist = Infinity;
      for (const place of places) {
        const d = meters(point, place.coordinates);
        if (d < dist) {
          dist = d;
          best = place;
        }
      }
      return dist <= 10000 ? best : undefined;
    };
  for (const r of records)
    if (r.kind !== "place") {
      const place = nearby(r.coordinates);
      if (place) r.context = `near ${place.name}`;
    }
  const streets: Street[] = [];
  const groups = new Map<
    string,
    {
      street: Street;
      point: Position;
      center: Position;
      distance: number;
      context?: string;
      aliases: Set<string>;
    }
  >();
  for (const f of features.features) {
    const tags = f.properties?.tags as Record<string, string> | undefined;
    if (!tags || !f.geometry) continue;
    const name = tags.name?.trim() ?? "",
      id = String(f.properties?.id ?? "");
    if (
      f.geometry.type === "LineString" &&
      STREET_TYPES.has(tags.highway!) &&
      tags.area !== "yes"
    ) {
      const coordinates = f.geometry.coordinates as Position[];
      if (coordinates.length < 2 || !coordinates.every(validPosition)) continue;
      const street: Street = {
        id,
        name: name || null,
        aliases: aliases(tags, name),
        category: tags.highway!,
        coordinates,
      };
      streets.push(street);
      if (!name) continue;
      const point = midpoint(coordinates),
        place = nearby(point),
        key = `${normalize(name)}|${place?.id ?? id}`;
      const center = place?.coordinates ?? point,
        candidate = nearestOnLine(center, coordinates);
      const old = groups.get(key);
      if (old) {
        for (const a of street.aliases) old.aliases.add(a);
        if (candidate.distanceMeters < old.distance) {
          old.street = street;
          old.point = candidate.coordinates;
          old.distance = candidate.distanceMeters;
        }
      } else
        groups.set(key, {
          street,
          point: candidate.coordinates,
          center,
          distance: candidate.distanceMeters,
          context: place ? `near ${place.name}` : undefined,
          aliases: new Set(street.aliases),
        });
    } else if (
      !tags.highway &&
      (tags.amenity ||
        tags.tourism ||
        tags.shop ||
        tags.historic ||
        (name && tags.building) ||
        tags["addr:housenumber"] ||
        tags.leisure ||
        tags.office ||
        tags.craft ||
        tags.healthcare ||
        tags.public_transport)
    ) {
      const line =
        f.geometry.type === "MultiPolygon"
          ? f.geometry.coordinates[0]?.[0]
          : f.geometry.type === "Polygon"
            ? f.geometry.coordinates[0]
            : f.geometry.type === "LineString"
              ? f.geometry.coordinates
              : undefined;
      if (!line?.length || !line.every(validPosition)) continue;
      const polygons =
        f.geometry.type === "MultiPolygon"
          ? f.geometry.coordinates
          : f.geometry.type === "Polygon"
            ? [f.geometry.coordinates]
            : undefined;
      const coordinates =
          (polygons ? areaAnchor(polygons as Position[][][]) : undefined) ??
          (line[0] as Position),
        place = nearby(coordinates);
      const address = explicitAddress(tags);
      records.push(
        enrichLocation({
          id,
          name:
            name ||
            (address
              ? addressText(address)
              : tags.amenity ||
                tags.shop ||
                tags.tourism ||
                tags.leisure ||
                tags.office ||
                tags.craft ||
                tags.healthcare ||
                tags.public_transport ||
                tags.historic ||
                "Unnamed POI"),
          aliases: aliases(tags, name),
          kind: name || !address ? "poi" : "address",
          tags: { ...tags },
          category:
            tags.amenity ||
            tags.tourism ||
            tags.shop ||
            tags.historic ||
            "building",
          coordinates,
          context: place ? `near ${place.name}` : undefined,
        }),
      );
    }
  }
  for (const [key, g] of groups) {
    const record: Location = {
      id: g.street.id,
      name: g.street.name!,
      aliases: [...g.aliases].sort(),
      kind: "street",
      category: "street",
      coordinates: g.point,
      context: g.context,
    };
    if (options.group) options.group(key, record, g.distance);
    else records.push(record);
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  streets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    locations: { schema: "locations-v1", records },
    streets: { schema: "streets-v1", streets },
  };
}
