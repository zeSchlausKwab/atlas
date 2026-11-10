import type { AtlasReader } from "../../format/src/reader";
export type Bounds = [number, number, number, number];
import { MAX_SEARCH_PAGE } from "./paging";
export type CellKind = "locations" | "streets";
export interface CellPage {
  key: string;
  bounds: Bounds;
  count: number;
}
export interface CellCatalog {
  schema: string;
  pages: CellPage[];
}
const decoder = new TextDecoder();
/** Dense spatial cells reference bounded payloads in the same archive. Old inline cells still work. */
export async function* readSearchCell(
  reader: Pick<AtlasReader, "block">,
  key: string,
  kind: CellKind,
  bounds?: Bounds,
  signal?: AbortSignal,
  visit?: (key: string) => Promise<void>,
  metadataOnly = false,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  await visit?.(key);
  const bytes = await reader.block(key);
  if (bytes.length > MAX_SEARCH_PAGE)
    throw new Error("Search cell exceeds 4 MiB");
  const value = JSON.parse(decoder.decode(bytes));
  if (value.schema === `${kind}-v1`) {
    yield bytes;
    return;
  }
  if (
    value.schema !== `${kind}-cell-paged-v1` ||
    !Array.isArray(value.pages) ||
    !value.pages.length
  )
    throw new Error("Invalid search cell catalog");
  const seen = new Set<string>();
  const prefix = kind === "locations" ? "location-pages" : "street-pages";
  const pattern = new RegExp(`^search/${prefix}/16/(\\d+)/(\\d+)$`);
  // Validate the whole directory before following any reference, including pruned pages.
  for (const p of value.pages) {
    const match = typeof p?.key === "string" && pattern.exec(p.key);
    const b = p?.bounds;
    if (
      !match ||
      Number(match[1]) >= 65536 ||
      Number(match[2]) >= 65536 ||
      seen.has(p.key) ||
      !Number.isSafeInteger(p.count) ||
      p.count < 1 ||
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every(Number.isFinite) ||
      b[0] < -180 ||
      b[2] > 180 ||
      b[1] < -85 ||
      b[3] > 85 ||
      b[0] > b[2] ||
      b[1] > b[3]
    )
      throw new Error("Invalid search cell page");
    seen.add(p.key);
  }
  for (const p of value.pages as CellPage[]) {
    signal?.throwIfAborted();
    const b = p.bounds;
    if (
      bounds &&
      (b[2] < bounds[0] ||
        b[0] > bounds[2] ||
        b[3] < bounds[1] ||
        b[1] > bounds[3])
    )
      continue;
    await visit?.(p.key);
    if (metadataOnly) continue;
    const payload = await reader.block(p.key);
    signal?.throwIfAborted();
    if (payload.length > MAX_SEARCH_PAGE)
      throw new Error("Search cell page exceeds 4 MiB");
    const data = JSON.parse(decoder.decode(payload));
    const records = data[kind === "locations" ? "records" : "streets"];
    if (
      data.schema !== `${kind}-v1` ||
      !Array.isArray(records) ||
      records.length !== p.count
    )
      throw new Error("Invalid search cell page payload");
    yield payload;
  }
}
