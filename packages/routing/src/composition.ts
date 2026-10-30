import {
  federationIdentity,
  ownsRoutingCell,
} from "../../format/src/routing-contract";
import { AtlasReader } from "../../format/src/reader";
import {
  TRANSPORT_MODES,
  type Manifest,
  type TransportMode,
} from "../../format/src/index";
import { selectedCell } from "../../offline/src/geometry";
import { profilePrefix, validateTransport } from "./index";
import { checkRoutingCodec, readRoutingCell, type CellRead } from "./paged";
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
    (manifest.transport?.federation
      ? federationIdentity(manifest.transport.federation)
      : undefined) ??
    manifest.transport?.graphSnapshot ??
    (!manifest.selection && manifest.transport ? manifest.snapshot : undefined)
  );
}
export function routingCompatibility(manifests: Manifest[]) {
  const maps = manifests.filter((m) => m.transport);
  const identity = maps[0] ? graphIdentity(maps[0]) : undefined;
  const compatible =
    !!identity && maps.every((m) => graphIdentity(m) === identity);
  const kind = maps.every((m) => m.transport?.federation)
    ? "osm-source"
    : "shared-graph";
  const profiles = TRANSPORT_MODES.filter((mode) =>
    maps.some((m) => m.transport?.profiles[mode]),
  );
  const partialProfiles = profiles.filter((mode) =>
    maps.some((m) => !m.transport?.profiles[mode]),
  );
  const message = !maps.length
    ? "No selected map supplies routing."
    : !compatible
      ? "Routing sources are not compatible: use independent RCL3 extracts of the same OSM source revision and routing contract, or legacy excerpts from one shared compiled graph."
      : `${maps.length} routing map${maps.length === 1 ? "" : "s"} · ${kind === "osm-source" ? "independent builds from one OSM revision" : "shared compiled graph"}. Cells and overlaps are checked as routes load.${partialProfiles.length ? ` ${partialProfiles.join(", ")} is unavailable in some maps; routes may need more coverage.` : ""}`;
  return {
    compatible,
    kind: kind as "osm-source" | "shared-graph",
    identity,
    profiles,
    partialProfiles,
    message,
  };
}
/** RCL3: independently compiled extracts of one OSM authority revision and contract.
 * RCL2: immutable excerpts of one compiled graph. Overlap is checked before
 * choosing an owner; display priority never decides routing ownership. */
export class RoutingComposition implements RoutingCellProvider {
  readonly snapshot: string;
  readonly compatibility: "osm-source" | "shared-graph";
  readonly sourceSnapshots: string[];
  readonly served = new Map<string, { source: string; bytes: number }>();
  constructor(readonly sources: { id: string; reader: AtlasReader }[]) {
    if (!sources.length)
      throw new Error("Select at least one map with transport data.");
    const compatibility = routingCompatibility(
      sources.map((s) => s.reader.index.manifest),
    );
    if (!compatibility.compatible) throw new Error(compatibility.message);
    this.compatibility = compatibility.kind;
    this.sourceSnapshots = [
      ...new Set(sources.map((s) => s.reader.index.manifest.snapshot)),
    ].sort();
    this.snapshot = compatibility.identity!;
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
      if (
        m.transport.federation &&
        !ownsRoutingCell(m.transport.federation, x, y)
      )
        return false;
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
          "The route needs complete routing cells outside the selected composition. Add a covering map with a compatible OSM source revision and routing contract (or the same legacy graph).",
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
      throw new Error(
        `Conflicting cells in the routing composition: ${key}. Source revision, topology, costs or restrictions disagree.`,
      );
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
        checkRoutingCodec(candidate.reader, key, bytes);
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
