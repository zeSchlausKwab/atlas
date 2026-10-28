import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { BlockWriter } from "../../cli/src/stream-writer";
import {
  archiveKey,
  encode,
  facets,
  geometryBounds,
  objectId,
  type SourceObject,
  type ObjectRecord,
  type Page,
  type RetentionReport,
} from "./model";
export class ObjectWriter {
  private db: Database;
  private ordinal = 0;
  private closed = false;
  readonly report: RetentionReport = {
    schema: "retention-v1",
    profile: "tagged-objects-and-way-dependencies",
    counts: Object.create(null),
    geometryStatus: Object.create(null),
    facets: Object.create(null),
    tagKeys: Object.create(null),
    encountered: Object.create(null),
    omitted: Object.create(null),
    geometryBytes: 0,
    topologyBytes: 0,
    metadataBytes: 0,
    scope:
      "objects encountered in the supplied PBF; whole intersecting geometry; relationship references may point outside the excerpt",
    realWorldCompleteness: "unknown",
    limitations: [
      "Untagged coordinate nodes are represented by way coordinates and ordered node IDs, not separate feature records.",
      "Relation membership is retained; arbitrary relations are not interpreted as polygons or routes.",
      "Unknown closed ways remain lines unless recognized as areas; absent tags are unknown.",
      "OSM object versions and timestamps are not retained by this importer; source snapshot identity applies.",
      "Coastline ways are physical edges; ocean polygons require an assembled land/sea source.",
      "Depth, elevation surfaces, timetables and changing conditions require additional sources.",
    ],
  };
  constructor(
    private writer: BlockWriter,
    private path = `${tmpdir()}/atlas-object-index-${crypto.randomUUID()}.sqlite`,
  ) {
    this.db = new Database(path);
    this.db.run(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; CREATE TABLE records(id TEXT PRIMARY KEY,cell INTEGER,json TEXT,page TEXT); BEGIN",
    );
  }
  private bump(a: Record<string, number>, k: string) {
    a[k] = (a[k] ?? 0) + 1;
  }
  private async blob(kind: string, value: unknown) {
    const bytes = encode(value),
      blocks: string[] = [];
    for (let at = 0; at < bytes.length; at += 1024 ** 2) {
      const key = archiveKey(kind, this.ordinal++);
      await this.writer.add({ key, bytes: bytes.slice(at, at + 1024 ** 2) });
      blocks.push(key);
    }
    return { blocks, bytes: bytes.length };
  }
  async add(v: SourceObject) {
    if (
      !objectId(v.id) ||
      !v.tags ||
      Object.values(v.tags).some((x) => typeof x !== "string")
    )
      throw new Error("Invalid source object");
    if (this.db.query("SELECT id FROM records WHERE id=?").get(v.id))
      throw new Error(`Duplicate source identity ${v.id}`);
    const bounds = v.geometry ? geometryBounds(v.geometry) : [],
      f = facets(v.tags);
    const row: ObjectRecord = {
      id: v.id,
      name: v.tags.name ?? v.tags.official_name ?? "",
      tags: v.tags,
      facets: f,
      bounds,
      geometryStatus: v.geometryStatus,
      dependencyOnly: v.dependencyOnly ?? false,
    };
    if (v.geometry) {
      row.geometry = await this.blob("geometry", v.geometry);
      this.report.geometryBytes += row.geometry.bytes;
    }
    if (v.nodeRefs || v.members) {
      row.topology = await this.blob("topology", {
        nodeRefs: v.nodeRefs,
        members: v.members,
        unavailableMembers: v.unavailableMembers ?? [],
      });
      this.report.topologyBytes += row.topology.bytes;
    }
    const json = JSON.stringify(row);
    if (encode(row).length > 256 * 1024)
      throw new Error(`Source object ${v.id} metadata exceeds 256 KiB`);
    const b = bounds[0],
      cell = b
        ? Math.floor((b[0] + 180) * 8) * 1441 + Math.floor((b[1] + 90) * 8)
        : -1;
    this.db
      .query("INSERT INTO records VALUES(?,?,?,NULL)")
      .run(v.id, cell, json);
    this.bump(this.report.encountered, v.id.split("/")[0]!);
    this.bump(this.report.counts, v.id.split("/")[0]!);
    this.bump(this.report.geometryStatus, v.geometryStatus);
    for (const k of f) this.bump(this.report.facets, k);
    for (const k of Object.keys(v.tags)) this.bump(this.report.tagKeys, k);
  }
  private async page(kind: string, rows: any[]): Promise<Page> {
    const key = archiveKey(kind, this.ordinal++),
      bounds = rows.flatMap((r) => r.bounds ?? []);
    // A conservative page envelope; records keep dateline-split extents.
    const box = bounds.length
      ? [
          bounds.reduce(
            (a, b) => [
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[2], b[2]),
              Math.max(a[3], b[3]),
            ],
            [180, 90, -180, -90],
          ),
        ]
      : [];
    const bytes = encode({ schema: `objects-${kind}-v1`, rows });
    if (bytes.length > 4 * 1024 ** 2)
      throw new Error("Object index page exceeds 4 MiB");
    this.report.metadataBytes += bytes.length;
    await this.writer.add({ key, bytes, features: rows.length });
    return {
      key,
      unlocated: rows.some(
        (r) =>
          r.unlocated ?? (Array.isArray(r.bounds) && r.bounds.length === 0),
      ),
      bounds: box as Page["bounds"],
      keys: [
        ...new Set(rows.flatMap((r) => r.keys ?? Object.keys(r.tags ?? {}))),
      ].sort(),
      facets: [...new Set(rows.flatMap((r) => r.facets ?? []))].sort(),
      count: rows.reduce((n, r) => n + (r.count ?? 1), 0),
      ...(rows[0]?.id
        ? { min: rows[0].id, max: rows.at(-1).id }
        : rows[0]?.min
          ? { min: rows[0].min, max: rows.at(-1).max }
          : {}),
    };
  }
  private async tree(kind: string, pages: Page[]): Promise<Page> {
    if (!pages.length) return this.page(kind, []);
    while (pages.length > 1) {
      const next: Page[] = [];
      for (let i = 0; i < pages.length; i += 64)
        next.push(await this.page(kind, pages.slice(i, i + 64)));
      pages = next;
    }
    return pages[0]!;
  }
  async finish() {
    try {
      this.db.run("COMMIT; CREATE INDEX records_spatial ON records(cell,id)");
      let batch: ObjectRecord[] = [],
        size = 0;
      const pages: Page[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const p = await this.page("records", batch);
        pages.push(p);
        for (const row of batch)
          this.db
            .query("UPDATE records SET page=? WHERE id=?")
            .run(p.key, row.id);
        batch = [];
        size = 0;
      };
      for (const row of this.db
        .query<
          { json: string },
          []
        >("SELECT json FROM records ORDER BY cell,id")
        .iterate()) {
        const v: ObjectRecord = JSON.parse(row.json);
        if (
          batch.length &&
          (batch.length >= 128 ||
            size + row.json.length > 192 * 1024 ||
            Boolean(batch[0]?.bounds.length) !== Boolean(v.bounds.length))
        )
          await flush();
        batch.push(v);
        size += row.json.length;
      }
      await flush();
      const lookup: Page[] = [];
      let ids: { id: string; page: string }[] = [];
      for (const row of this.db
        .query<
          { id: string; page: string },
          []
        >("SELECT id,page FROM records ORDER BY id")
        .iterate()) {
        ids.push(row);
        if (ids.length === 256) {
          lookup.push(await this.page("ids", ids));
          ids = [];
        }
      }
      if (ids.length) lookup.push(await this.page("ids", ids));
      const count = Object.values(this.report.counts).reduce(
        (a, b) => a + b,
        0,
      );
      const spatial = await this.tree("spatial", pages),
        idTree = await this.tree("lookup", lookup);
      await this.writer.add({
        key: "objects/index",
        bytes: encode({
          schema: "source-objects-v1",
          count,
          spatial,
          lookup: idTree,
          report: this.report,
        }),
        features: count,
      });
      return this.report;
    } finally {
      this.close();
    }
  }
  close() {
    if (!this.closed) {
      this.db.close();
      rmSync(this.path, { force: true });
      this.closed = true;
    }
  }
}
