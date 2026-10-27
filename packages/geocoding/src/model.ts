export type Position = [number, number];
export interface Location {
  id: string;
  name: string;
  aliases: string[];
  kind: "place" | "street" | "poi" | "peak" | "address";
  /** Explicit OSM tags; missing properties remain unknown. */
  tags?: Record<string, string>;
  address?: Address;
  category: string;
  coordinates: Position;
  context?: string;
}
export interface Street {
  id: string;
  name: string | null;
  aliases: string[];
  category: string;
  coordinates: Position[];
}
export interface LocationBlock {
  schema: "locations-v1";
  records: Location[];
}
export interface StreetBlock {
  schema: "streets-v1";
  streets: Street[];
}
export const REVERSE_LIMIT_METERS = 1000;
export function validPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 85
  );
}
export function normalize(value: string) {
  return value
    .toLowerCase()
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function meters(a: Position, b: Position) {
  const rad = Math.PI / 180,
    dlat = (b[1] - a[1]) * rad,
    dlon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
/** Local segment projection with spherical distance; suitable for short regional street segments. */
export function nearestOnLine(point: Position, line: Position[]) {
  const cos = Math.cos((point[1] * Math.PI) / 180);
  let coordinates: Position = line[0]!,
    distanceMeters = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!,
      b = line[i]!;
    const dx = (b[0] - a[0]) * cos,
      dy = b[1] - a[1],
      length = dx * dx + dy * dy;
    const t =
      length === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point[0] - a[0]) * cos * dx + (point[1] - a[1]) * dy) / length,
            ),
          );
    const p: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      d = meters(point, p);
    if (d < distanceMeters) {
      coordinates = p;
      distanceMeters = d;
    }
  }
  return { coordinates, distanceMeters };
}
/** UI uses explicitly labelled latitude, longitude; library APIs always use [longitude, latitude]. */
export function parseCoordinates(text: string): Position {
  const parts = text.trim().split(/\s*,\s*/);
  if (
    parts.length !== 2 ||
    parts.some((s) => !s || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s))
  )
    throw new Error(
      "Enter latitude, longitude, for example 47.13929, 9.52280.",
    );
  const position: Position = [Number(parts[1]), Number(parts[0])];
  if (!validPosition(position))
    throw new Error("Use longitude within ±180° and latitude within ±85°.");
  return position;
}

export interface Address {
  houseNumber: string;
  street?: string;
  place?: string;
  city?: string;
  postcode?: string;
  country?: string;
  source: "osm-explicit";
}
export function explicitAddress(
  tags: Record<string, string>,
): Address | undefined {
  const houseNumber = tags["addr:housenumber"]?.trim();
  if (!houseNumber) return;
  return {
    houseNumber,
    source: "osm-explicit",
    ...Object.fromEntries(
      ["street", "place", "city", "postcode", "country"].flatMap((key) =>
        tags[`addr:${key}`]?.trim() ? [[key, tags[`addr:${key}`].trim()]] : [],
      ),
    ),
  };
}
export function addressText(a: Address) {
  return [a.street ?? a.place, a.houseNumber, a.postcode, a.city, a.country]
    .filter(Boolean)
    .join(" ");
}
export function enrichLocation(record: Location): Location {
  const address = record.tags ? explicitAddress(record.tags) : record.address;
  return address
    ? {
        ...record,
        address,
        aliases: [...new Set([...record.aliases, addressText(address)])],
      }
    : record;
}
export const SEMANTIC_RETENTION = {
  version: 1 as const,
  addresses: "osm-explicit" as const,
  poiTags: true,
  administrativeHierarchy: false,
};
