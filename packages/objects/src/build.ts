import { measuredProgress } from "../../provisioning/src/compiler-progress";
import { PayloadPacker } from "./packing";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { BlockWriter } from "../../cli/src/stream-writer";
import {
  archiveKey,
  tagTerm,
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
  private ordinals = new Map<string, number>();
  private next = (kind: string) => {
    const n = this.ordinals.get(kind) ?? 0;
    this.ordinals.set(kind, n + 1);
    return archiveKey(kind, n);
  };
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
    // This is disposable staging, never a resume checkpoint.
    rmSync(path, { force: true });
    this.db = new Database(path);
    this.db.run(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; CREATE TABLE records(id TEXT PRIMARY KEY,cell INTEGER,bucket TEXT,json TEXT,geometry BLOB,topology BLOB,page TEXT); CREATE TABLE tags(term TEXT,id TEXT,PRIMARY KEY(term,id)) WITHOUT ROWID; CREATE TABLE pages(key TEXT PRIMARY KEY,json TEXT); BEGIN",
    );
  }
  private bump(a: Record<string, number>, k: string) {
    a[k] = (a[k] ?? 0) + 1;
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
    const geometry = v.geometry ? encode(v.geometry) : null;
    const topology =
      v.nodeRefs || v.members
        ? encode({
            nodeRefs: v.nodeRefs,
            members: v.members,
            unavailableMembers: v.unavailableMembers ?? [],
          })
        : null;
    this.report.geometryBytes += geometry?.length ?? 0;
    this.report.topologyBytes += topology?.length ?? 0;
    const json = JSON.stringify(row);
    if (encode(row).length > 256 * 1024)
      throw new Error(`Source object ${v.id} metadata exceeds 256 KiB`);
    const b = bounds[0],
      cell = b
        ? Math.floor((b[0] + 180) * 8) * 1441 + Math.floor((b[1] + 90) * 8)
        : -1;
    // Group common semantic classes, then geography. Exact-tag postings point at these attribute pages.
    const primary = [
      "boundary",
      "amenity",
      "leisure",
      "natural",
      "highway",
      "railway",
      "waterway",
      "building",
      "building:part",
      "landuse",
      "shop",
      "tourism",
      "entrance",
      "barrier",
      "public_transport",
      "power",
      "man_made",
      "type",
    ].find((k) => Object.hasOwn(v.tags, k));
    const bucket = primary ? tagTerm(primary, v.tags[primary]!) : "";
    this.db
      .query("INSERT INTO records VALUES(?,?,?,?,?,?,NULL)")
      .run(v.id, cell, bucket, json, geometry, topology);
    const insert = this.db.query("INSERT INTO tags VALUES(?,?)");
    for (const [key, value] of Object.entries(v.tags))
      insert.run(tagTerm(key, value), v.id);
    this.bump(this.report.encountered, v.id.split("/")[0]!);
    this.bump(this.report.counts, v.id.split("/")[0]!);
    this.bump(this.report.geometryStatus, v.geometryStatus);
    for (const k of f) this.bump(this.report.facets, k);
    for (const k of Object.keys(v.tags)) this.bump(this.report.tagKeys, k);
  }
  private async page(kind: string, rows: any[]): Promise<Page> {
    const key = this.next(kind),
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
      ...(rows[0]?.term
        ? { min: rows[0].term, max: rows.at(-1).term }
        : rows[0]?.id
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
  async finish(progress: (s: string) => void = () => {}) {
    try {
      const count = Object.values(this.report.counts).reduce(
        (a, b) => a + b,
        0,
      );
      progress(
        "ATLAS_PROGRESS " +
          JSON.stringify({
            stage: "semantic-object-index",
            message: "Indexing source objects for packing",
            completed: 0,
            total: 0,
            unit: "objects",
          }),
      );
      this.db.run(
        "COMMIT; CREATE INDEX records_spatial ON records(bucket,cell,id); BEGIN",
      );
      const packingProgress = measuredProgress(
        progress,
        "semantic-object-packing",
        "Packing source objects",
        count,
        "objects",
      );
      const packer = new PayloadPacker(this.writer, this.next);
      let packed = 0,
        lastBucket: string | undefined;
      let batch: ObjectRecord[] = [],
        size = 0;
      const pages: Page[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const p = await this.page("records", batch);
        pages.push(p);
        this.db
          .query("INSERT INTO pages VALUES(?,?)")
          .run(p.key, JSON.stringify(p));
        for (const row of batch)
          this.db
            .query("UPDATE records SET page=? WHERE id=?")
            .run(p.key, row.id);
        batch = [];
        size = 0;
      };
      for (const row of this.db
        .query<
          {
            json: string;
            bucket: string;
            geometry: Uint8Array | null;
            topology: Uint8Array | null;
          },
          []
        >(
          "SELECT json,bucket,geometry,topology FROM records ORDER BY bucket,cell,id",
        )
        .iterate()) {
        const v: ObjectRecord = JSON.parse(row.json);
        if (row.geometry)
          v.geometry = await packer.add("geometry", row.geometry);
        if (row.topology)
          v.topology = await packer.add("topology", row.topology);
        if (encode(v).length > 256 * 1024)
          throw new Error(`Object ${v.id} metadata exceeds 256 KiB`);
        if (
          batch.length &&
          (lastBucket !== row.bucket ||
            batch.length >= 128 ||
            size + row.json.length > 192 * 1024 ||
            Boolean(batch[0]?.bounds.length) !== Boolean(v.bounds.length))
        )
          await flush();
        lastBucket = row.bucket;
        batch.push(v);
        size += row.json.length;
        if (++packed % 10000 === 0) {
          packingProgress(packed);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await flush();
      await packer.finish();
      packingProgress(packed);
      this.db.run("COMMIT");
      const lookupProgress = measuredProgress(
        progress,
        "semantic-object-lookup",
        "Indexing source identities",
        count,
        "objects",
      );
      let indexed = 0;
      const lookup: Page[] = [];
      let ids: { id: string; page: string }[] = [];
      for (const row of this.db
        .query<
          { id: string; page: string },
          []
        >("SELECT id,page FROM records ORDER BY id")
        .iterate()) {
        ids.push(row);
        if (++indexed % 10000 === 0) lookupProgress(indexed);
        if (ids.length === 256) {
          lookup.push(await this.page("ids", ids));
          ids = [];
        }
      }
      if (ids.length) lookup.push(await this.page("ids", ids));
      lookupProgress(indexed);
      const tagProgress = measuredProgress(
        progress,
        "semantic-object-tags",
        "Indexing exact tag values",
        0,
        "terms",
      );
      let indexedTerms = 0;
      const tagPages: Page[] = [];
      let terms: { term: string; root?: Page; pages?: string[] }[] = [],
        termBytes = 0;
      let term: string | undefined,
        postings: Page[] = [];
      const flushTerms = async () => {
        if (terms.length) tagPages.push(await this.page("tag-values", terms));
        terms = [];
        termBytes = 0;
      };
      const flushTerm = async () => {
        if (term === undefined) return;
        tagProgress(++indexedTerms);
        const entry =
            postings.length <= 8
              ? { term, pages: postings.map((p) => p.key) }
              : { term, root: await this.tree("tag-pages", postings) },
          bytes = encode(entry).length;
        if (
          terms.length &&
          (terms.length >= 64 || termBytes + bytes > 192 * 1024)
        )
          await flushTerms();
        terms.push(entry);
        termBytes += bytes;
        postings = [];
      };
      // SQLite streams distinct attribute-page postings without loading all tag/object pairs in RAM.
      for (const row of this.db
        .query<
          { term: string; json: string },
          []
        >("SELECT DISTINCT tags.term,records.page,pages.json FROM tags JOIN records ON records.id=tags.id JOIN pages ON pages.key=records.page ORDER BY tags.term,records.page")
        .iterate()) {
        if (row.term !== term) {
          await flushTerm();
          term = row.term;
        }
        postings.push(JSON.parse(row.json));
      }
      await flushTerm();
      await flushTerms();
      tagProgress(indexedTerms, true);
      progress(
        "ATLAS_PROGRESS " +
          JSON.stringify({
            stage: "semantic-object-trees",
            message: "Assembling source object indexes",
            completed: 0,
            total: 0,
            unit: "blocks",
          }),
      );
      const tagTree = await this.tree("tag-index", tagPages);
      const spatial = await this.tree("spatial", pages),
        idTree = await this.tree("lookup", lookup);
      await this.writer.add({
        key: "objects/index",
        bytes: encode({
          schema: "source-objects-v2",
          tags: tagTree,
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
