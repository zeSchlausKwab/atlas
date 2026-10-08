import type { Place } from "../../format/src/index";
export const PLACE_LABEL_KEY = "labels/places";
export function decodePlaces(bytes: Uint8Array): Place[] {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (
    value?.schema !== "places-v1" ||
    !Array.isArray(value.places) ||
    value.places.length > 100000 ||
    value.places.some(
      (p: Place) =>
        !p ||
        typeof p.name !== "string" ||
        p.name.length > 500 ||
        !Array.isArray(p.coordinates) ||
        p.coordinates.length !== 2 ||
        !p.coordinates.every(Number.isFinite) ||
        Math.abs(p.coordinates[0]) > 180 ||
        Math.abs(p.coordinates[1]) > 85,
    )
  )
    throw new Error("Invalid settlement labels");
  return value.places;
}
export const encodePlaces = (places: Place[]) =>
  new TextEncoder().encode(JSON.stringify({ schema: "places-v1", places }));
