import type { Bounds } from "./cell-pages";
import type { Location, Street } from "./model";
import type { CellKind, CellPage } from "./cell-pages";
import { MAX_SEARCH_PAGE } from "./paging";
const encoder = new TextEncoder();
export const SEARCH_CELL_PAGE_TARGET = 256 * 1024;
/** Streams one cell from SQLite. Exact UTF-8 accounting includes wrapper and commas. */
export async function writeSearchCell(
  kind: CellKind,
  key: string,
  rows: Iterable<{ json: string }>,
  nextKey: () => string,
  write: (key: string, value: unknown, features?: number) => Promise<void>,
  signal?: AbortSignal,
) {
  const field = kind === "locations" ? "records" : "streets";
  const schema = `${kind}-v1`;
  const overhead = encoder.encode(
    JSON.stringify({ schema, [field]: [] }),
  ).length;
  let values: (Location | Street)[] = [],
    size = overhead,
    bounds: Bounds = [180, 85, -180, -85];
  const pages: CellPage[] = [];
  const flush = async () => {
    const pageKey = nextKey();
    await write(pageKey, { schema, [field]: values }, values.length);
    pages.push({ key: pageKey, bounds, count: values.length });
    values = [];
    size = overhead;
    bounds = [180, 85, -180, -85];
  };
  for (const { json } of rows) {
    signal?.throwIfAborted();
    const record = JSON.parse(json) as Location | Street;
    const length = encoder.encode(json).length;
    if (length + overhead > MAX_SEARCH_PAGE)
      throw new Error(`Search ${kind} record ${record.id} exceeds 4 MiB`);
    if (values.length && size + 1 + length > SEARCH_CELL_PAGE_TARGET)
      await flush();
    size += length + (values.length ? 1 : 0);
    values.push(record);
    const points =
      kind === "locations"
        ? [(record as Location).coordinates]
        : (record as Street).coordinates;
    for (const [x, y] of points) {
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x);
      bounds[3] = Math.max(bounds[3], y);
    }
  }
  if (!pages.length) {
    await write(key, { schema, [field]: values }, values.length);
    return;
  }
  if (values.length) await flush();
  await write(
    key,
    { schema: `${kind}-cell-paged-v1`, pages },
    pages.reduce((n, p) => n + p.count, 0),
  );
}
