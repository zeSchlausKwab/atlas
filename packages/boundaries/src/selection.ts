/** OSM levels are country-specific, not a universal municipality classification.
 * Missing/malformed levels remain included when no filter was requested. */
export function includesAdminLevel(
  tags: Record<string, unknown>,
  max?: number,
) {
  if (max === undefined) return true;
  const value = String(tags.admin_level ?? "");
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max;
}
export function boundarySelectionNote(max?: number) {
  return max === undefined
    ? []
    : [
        `Administrative boundaries retain original geometry; only numeric OSM admin_level 1–${max} are included. Missing levels and finer divisions are omitted. Municipality levels and source coverage vary by country.`,
      ];
}
