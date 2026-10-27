/** Search pages share the archive directory, but record/posting addresses are ordinals, not geography. */
export const RECORDS_PER_PAGE = 256;
export const POSTINGS_PER_PAGE = 4096;
export const STREET_ZOOM = 14;
export const MAX_SEARCH_PAGE = 4 * 1024 * 1024;
export const MAX_CANDIDATES = 50000;
export interface SearchCatalog {
  schema: "locations-paged-v1";
  names?: true;
  records: number;
  pages: number;
}
export interface StreetCatalog {
  schema: "streets-paged-v1";
  streets: number;
  zoom: 14;
}
export interface Term {
  term: string;
  count: number;
  start: number;
  pages: number;
}
export function ordinalKey(
  kind: "records" | "postings" | "location-pages" | "street-pages",
  page: number,
) {
  if (!Number.isSafeInteger(page) || page < 0 || page >= 2 ** 32)
    throw new Error("Search page ordinal overflow");
  const leaf = Math.floor(page / 1024),
    slot = page % 1024;
  return `search/${kind}/16/${(leaf % 2048) * 32 + Math.floor(slot / 32)}/${Math.floor(leaf / 2048) * 32 + (slot % 32)}`;
}
export function termBucket(term: string) {
  let hash = 2166136261;
  for (let i = 0; i < term.length; i++)
    hash = Math.imul(hash ^ term.charCodeAt(i), 16777619);
  return (hash >>> 0) % 65536;
}
export function termKey(bucket: number) {
  return `search/terms/8/${bucket >> 8}/${bucket & 255}`;
}
export function grams(text: string) {
  const result = new Set<string>();
  for (let length = 1; length <= 3; length++)
    for (let i = 0; i + length <= text.length; i++)
      result.add(text.slice(i, i + length));
  return result;
}
export function queryGrams(query: string) {
  return [
    ...new Set(
      query.split(" ").flatMap((token) => {
        const n = Math.min(3, token.length);
        return Array.from({ length: token.length - n + 1 }, (_, i) =>
          token.slice(i, i + n),
        );
      }),
    ),
  ];
}
export function pagedZoom(prefix: string): number | undefined {
  if (prefix === "features/attributes" || prefix === "features/geometry")
    return 16;
  if (
    prefix === "search/records" ||
    prefix === "search/postings" ||
    prefix === "search/location-pages" ||
    prefix === "search/street-pages"
  )
    return 16;
  if (prefix === "search/terms") return 8;
  if (prefix === "search/streets-data" || prefix === "search/locations-data")
    return STREET_ZOOM;
}
