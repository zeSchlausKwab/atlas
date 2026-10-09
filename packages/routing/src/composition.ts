import { AtlasReader } from "../../format/src/reader";
import { type Manifest, type TransportMode } from "../../format/src/index";
import { selectedCell } from "../../offline/src/geometry";
import { profilePrefix, validateTransport } from "./index";
import { readRoutingCell, type CellRead } from "./paged";
export interface RoutingCellProvider {
  snapshot: string;
  prefix(mode: TransportMode): string;
  read(key: string): Promise<CellRead>;
}
export function singleRoutingSource(reader: AtlasReader): RoutingCellProvider {
  return {
    snapshot: reader.index.manifest.snapshot,
    prefix: (mode) => profilePrefix(reader, mode),
    read: (key) => readRoutingCell(reader, key),
  };
}
export function graphIdentity(manifest: Manifest) {
  return (
    manifest.transport?.graphSnapshot ??
    (!manifest.selection && manifest.transport ? manifest.snapshot : undefined)
  );
}
/** Adjacent excerpts of one compiled graph. Never merges unrelated OSM snapshots.
 * Shared cell hashes are checked before choosing an owner; geometry priority is
 * intentionally independent from routing ownership. */
export class RoutingComposition implements RoutingCellProvider {
  readonly snapshot: string;
  readonly served = new Map<string, { source: string; bytes: number }>();
  constructor(readonly sources: { id: string; reader: AtlasReader }[]) {
    if (!sources.length)
      throw new Error("Select at least one map with transport data.");
    const identities = sources.map((s) =>
      graphIdentity(s.reader.index.manifest),
    );
    if (!identities[0] || identities.some((id) => id !== identities[0]))
      throw new Error(
        "Client routing needs excerpts from one shared compiled graph. These sources are not compatible.",
      );
    this.snapshot = identities[0];
  }
  prefix(mode: TransportMode) {
    validateTransport(mode);
    const available = this.sources.filter(
      (s) => s.reader.index.manifest.transport?.profiles[mode],
    );
    if (!available.length)
      throw new Error(`No selected map supplies ${mode} routing.`);
    return profilePrefix(available[0]!.reader, mode);
  }
  async read(key: string): Promise<CellRead> {
    const match =
      /^routing\/(walking|cycling|driving)\/cells\/14\/(\d+)\/(\d+)$/.exec(key);
    if (!match || +match[2]! >= 16384 || +match[3]! >= 16384)
      throw new Error("Invalid composition routing cell");
    const mode = match[1] as TransportMode,
      x = +match[2]!,
      y = +match[3]!;
    const sources = this.sources.filter(({ reader }) => {
      if (
        reader.options.purposes &&
        !reader.options.purposes.includes("routing")
      )
        throw new Error("Routing is disabled");
      const m = reader.index.manifest;
      if (!m.transport?.profiles[mode]) return false;
      const [w, s, e, n] = m.bounds;
      return selectedCell(
        m.selection?.polygon ?? [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
        ],
        14,
        x,
        y,
        m.selection?.routingPaddingCells ?? 0,
      );
    });
    if (!sources.length)
      return {
        missing: true,
        reason:
          "The route needs routing cells outside the selected composition. Add covering excerpts from the same compiled graph.",
        fetchedBytes: 0,
      };
    const candidates = [];
    let unavailable = false;
    for (const source of sources) {
      try {
        const blocks = await source.reader.spatial(
          `routing/${mode}/cells`,
          14,
          x,
          x,
          y,
          y,
        );
        candidates.push({
          ...source,
          block: blocks.find((b) => b.key === key),
        });
      } catch (e) {
        if (!transportFailure(source.reader, e)) throw e;
        unavailable = true;
      }
    }
    const hashes = new Set(candidates.map((c) => c.block?.hash ?? "empty"));
    if (hashes.size > 1)
      throw new Error(`Conflicting cells in the shared graph: ${key}`);
    if (candidates.length && !candidates[0]!.block)
      return { empty: true, fetchedBytes: 0 };
    candidates.sort(
      (a, b) =>
        Number(b.reader.cache.has(key)) - Number(a.reader.cache.has(key)),
    );
    for (const candidate of candidates) {
      const before = candidate.reader.bytesByPurpose.routing;
      try {
        const bytes = await candidate.reader.block(key),
          fetchedBytes = candidate.reader.bytesByPurpose.routing - before;
        this.served.set(key, { source: candidate.id, bytes: fetchedBytes });
        return { bytes, fetchedBytes };
      } catch (e) {
        if (!transportFailure(candidate.reader, e)) throw e;
        unavailable = true;
      }
    }
    return {
      missing: true,
      reason: unavailable
        ? "A needed cell is unavailable from the selected hosts or cache."
        : "Routing cell unavailable.",
      fetchedBytes: 0,
    };
  }
}
function transportFailure(reader: AtlasReader, error: unknown) {
  return (
    (reader.offline &&
      error instanceof Error &&
      error.message.startsWith("Not cached:")) ||
    (error instanceof TypeError && /fetch|network|load/i.test(error.message))
  );
}
