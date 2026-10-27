/** Visual detail is independent of the full-resolution query/routing data. */
export function displayMinZoom(properties: Record<string, unknown>): number {
  const cls = Number(properties.class);
  if (cls === 8) return Infinity;
  const tags = properties.tags as Record<string, string> | undefined;
  const highway = tags?.highway ?? "";
  if (cls === 2) return 13;
  if (cls === 5) return 14;
  if (cls === 3)
    return highway === "tertiary" || highway === "tertiary_link"
      ? 11
      : highway === "service"
        ? 14
        : 12;
  if (cls === 4) {
    if (highway.startsWith("motorway")) return 0;
    if (highway.startsWith("trunk")) return 5;
    if (highway.startsWith("primary")) return 8;
    return 10;
  }
  if (cls === 6) return 9;
  if (cls === 7) return 12;
  if (cls === 1 && tags?.waterway && !tags?.natural)
    return tags.waterway === "river" || tags.waterway === "canal" ? 9 : 14;
  return 0;
}
