import {
  validPosition,
  type Position,
  type Location,
} from "../../geocoding/src/model";
export const LABEL_ZOOM = 12;
export interface RoadLabel {
  id: string;
  name: string;
  category: string;
  coordinates: Position[];
}
export interface LabelBlock {
  schema: "labels-v1";
  roads: RoadLabel[];
  pois: Location[];
}
export function decodeLabels(bytes: Uint8Array): LabelBlock {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as LabelBlock;
  const identity = (s: unknown) =>
    typeof s === "string" && /^(node|way|relation)\/\d+$/.test(s);
  const name = (s: unknown) =>
    typeof s === "string" && s.length > 0 && s.length <= 1000;
  let points = 0;
  if (
    data.schema !== "labels-v1" ||
    !Array.isArray(data.roads) ||
    !Array.isArray(data.pois) ||
    data.roads.length > 100000 ||
    data.pois.length > 100000 ||
    !data.roads.every(
      (r) =>
        identity(r.id) &&
        name(r.name) &&
        name(r.category) &&
        Array.isArray(r.coordinates) &&
        r.coordinates.length >= 2 &&
        (points += r.coordinates.length) <= 1000000 &&
        r.coordinates.every(validPosition),
    ) ||
    !data.pois.every(
      (p) =>
        identity(p.id) &&
        name(p.name) &&
        name(p.category) &&
        p.kind === "poi" &&
        validPosition(p.coordinates) &&
        Array.isArray(p.aliases) &&
        p.aliases.every((a) => typeof a === "string"),
    )
  )
    throw new Error("Invalid map label block");
  return data;
}
export function roadMinZoom(category: string) {
  return ["motorway", "trunk", "primary", "secondary"].includes(category)
    ? 13
    : category === "service" || category === "track"
      ? 17
      : 15;
}
export function poiMinZoom(category: string) {
  return [
    "museum",
    "hospital",
    "station",
    "university",
    "attraction",
    "castle",
    "townhall",
  ].includes(category)
    ? 14
    : [
          "restaurant",
          "cafe",
          "hotel",
          "school",
          "place_of_worship",
          "supermarket",
        ].includes(category)
      ? 16
      : 17;
}
export function poiColor(category: string) {
  return ["restaurant", "cafe", "bar", "pub", "fast_food"].includes(category)
    ? "#9a5730"
    : ["hospital", "doctors", "pharmacy", "clinic"].includes(category)
      ? "#a24949"
      : ["station", "bus_stop", "stop_position", "platform"].includes(category)
        ? "#366b92"
        : ["museum", "attraction", "castle", "monument"].includes(category)
          ? "#77603a"
          : "#665689";
}
