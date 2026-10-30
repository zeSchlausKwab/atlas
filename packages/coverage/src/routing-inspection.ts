import {
  project,
  TRANSPORT_MODES,
  type Manifest,
  type TransportMode,
} from "../../format/src/index";
import type { AtlasReader } from "../../format/src/reader";
import { ownsRoutingCell } from "../../format/src/routing-contract";
import { graphIdentity } from "../../routing/src/composition";
import {
  bounds,
  selectedCell,
  validatePolygon,
  type Polygon,
} from "../../offline/src/geometry";
type InspectionSource =
  | { id: string; reader: AtlasReader }
  | { id: string; manifest: Manifest; reader?: undefined };
const manifestOf = (s: InspectionSource) =>
  s.reader ? s.reader.index.manifest : s.manifest;
/** Check only hash-verified directory entries. An absent entry in a complete owned
 * cell is verified empty, not a coverage hole. No graph payloads are downloaded. */
export async function inspectRouting(
  polygon: Polygon,
  mode: TransportMode,
  sources: InspectionSource[],
  reference: string,
  signal?: AbortSignal,
) {
  validatePolygon(polygon);
  if (!TRANSPORT_MODES.includes(mode)) throw Error("Unknown transport mode");
  const b = bounds(polygon),
    a = project(b[0], b[3]),
    c = project(b[2], b[1]),
    n = 16384;
  const x0 = Math.max(0, Math.floor(a[0] * n)),
    x1 = Math.min(n - 1, Math.floor(c[0] * n)),
    y0 = Math.max(0, Math.floor(a[1] * n)),
    y1 = Math.min(n - 1, Math.floor(c[1] * n));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096)
    throw Error(
      "Choose a smaller area for detailed routing inspection (up to 4,096 z14 cells). Regional scope planning has no cell scan.",
    );
  const ref = sources.find((s) => s.id === reference);
  if (!ref?.reader || !ref.reader.index.manifest.transport?.profiles[mode])
    throw Error(
      "Choose a verified routing reference map with this travel mode.",
    );
  const identity = graphIdentity(ref.reader.index.manifest);
  if (!identity) throw Error("Choose a verified routing reference map.");
  const counts = {
      present: 0,
      empty: 0,
      missing: 0,
      conflict: 0,
      unknown: 0,
      incompatible: 0,
    },
    cells = [];
  const directories = new Map<string, Map<string, string> | Error>();
  for (const s of sources) {
    signal?.throwIfAborted();
    if (!manifestOf(s).transport?.profiles[mode]) continue;
    if (!s.reader) {
      directories.set(s.id, Error("Archive is unavailable or unverified"));
      continue;
    }
    try {
      directories.set(
        s.id,
        new Map(
          (
            await s.reader.spatial(`routing/${mode}/cells`, 14, x0, x1, y0, y1)
          ).map((b) => [b.key, b.hash]),
        ),
      );
    } catch (e) {
      directories.set(s.id, e instanceof Error ? e : new Error(String(e)));
    }
  }
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      signal?.throwIfAborted();
      if (!selectedCell(polygon, 14, x, y)) continue;
      const owners = sources.filter((s) => {
        const m = manifestOf(s);
        return (
          m.transport?.profiles[mode] &&
          (!m.transport.federation ||
            ownsRoutingCell(m.transport.federation, x, y)) &&
          selectedCell(
            m.selection?.polygon ?? [
              [m.bounds[0], m.bounds[1]],
              [m.bounds[2], m.bounds[1]],
              [m.bounds[2], m.bounds[3]],
              [m.bounds[0], m.bounds[3]],
            ],
            14,
            x,
            y,
            m.selection?.routingPaddingCells ?? 0,
          )
        );
      });
      const compatible = owners.filter(
          (s) => graphIdentity(manifestOf(s)) === identity,
        ),
        hashes = new Set<string>();
      let unavailable = owners.some((s) => !s.reader);
      for (const s of compatible) {
        const d = directories.get(s.id);
        if (d instanceof Map)
          hashes.add(d.get(`routing/${mode}/cells/14/${x}/${y}`) ?? "empty");
        else unavailable = true;
      }
      const state: keyof typeof counts =
        hashes.size > 1
          ? "conflict"
          : unavailable
            ? "unknown"
            : hashes.size
              ? hashes.has("empty")
                ? "empty"
                : "present"
              : owners.length
                ? "incompatible"
                : "missing";
      counts[state]++;
      cells.push({ x, y, state, providers: compatible.map((s) => s.id) });
    }
  return {
    zoom: 14,
    mode,
    reference,
    counts,
    cells,
    evidence: "verified-routing-directory",
    payloadsChecked: false,
  };
}
