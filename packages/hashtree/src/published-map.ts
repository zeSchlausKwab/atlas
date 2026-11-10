import type { MapOffer } from "../../format/src/catalog";
import type { AtlasReader } from "../../format/src/reader";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Signed offers are hints until verified against the root-pinned archive.
 * Return its actual metadata; publishers cannot override routing or coverage. */
export function verifyPublishedMap(offer: MapOffer, reader: AtlasReader) {
  const actual = reader.index.manifest;
  if (
    actual.snapshot !== offer.manifest.snapshot ||
    reader.index.header.fileLength !== offer.bytes
  )
    throw new Error(
      "Published snapshot or file size differs from the pinned archive. Reopen discovery.",
    );
  for (const key of [
    "transport",
    "bounds",
    "selection",
    "capabilities",
    "composition",
  ] as const)
    if (canonical(actual[key]) !== canonical(offer.manifest[key]))
      throw new Error(`Published ${key} differs from the pinned archive.`);
  return actual;
}
