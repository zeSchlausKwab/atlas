import { measuredProgress } from "../../provisioning/src/compiler-progress";
import type { ObjectStaging } from "./staging";
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
  private packer: PayloadPacker;
  private state: any = {
    phase: "ingest",
    input: {},
    packed: 0,
    indexed: 0,
    terms: 0,
  };
  get inputState() {
    return this.state.input;
  }
  get ingestComplete() {
    return this.state.phase !== "ingest";
  }
  async checkpoint(input = this.state.input) {
    await this.packer.finish();
    this.state.input = input;
    if (this.staging)
      await this.staging.checkpoint({
        ...this.state,
        report: this.report,
        ordinals: [...this.ordinals],
      });
    else this.db.run("COMMIT; BEGIN");
  }
  private async saveProgress(
    progress: (s: string) => void,
    stage: string,
    message: string,
    done: number,
    total: number,
    unit = "objects",
  ) {
    await this.checkpoint();
    if (this.staging)
      progress(
        "ATLAS_PROGRESS " +
          JSON.stringify({
            stage,
            message,
            completed: done,
            total,
            unit,
            checkpointAt: Date.now() / 1000,
            stagingBytes: this.staging.payloadBytes,
            indexBytes:
              this.db
                .query<{ page_count: number }, []>("PRAGMA page_count")
                .get()!.page_count *
              this.db
                .query<{ page_size: number }, []>("PRAGMA page_size")
                .get()!.page_size,
          }),
      );
  }
  private remember(kind: string, page: Page) {
    this.db
      .query("INSERT INTO index_pages(kind,key,json) VALUES(?,?,?)")
      .run(kind, page.key, JSON.stringify(page));
  }
  private remembered(kind: string): Page[] {
    return this.db
      .query<{ json: string }, [string]>(
        "SELECT json FROM index_pages WHERE kind=? ORDER BY seq",
      )
      .all(kind)
      .map((p) => JSON.parse(p.json));
  }
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
    private staging?: ObjectStaging,
    private signal?: AbortSignal,
  ) {
    if (staging) this.db = staging.db;
    else {
      rmSync(path, { force: true });
      this.db = new Database(path);
      this.db.run(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; BEGIN",
      );
    }
    this.db
      .run(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,cell INTEGER,bucket TEXT,data BLOB,page TEXT);
      CREATE TABLE IF NOT EXISTS tags(term TEXT,page TEXT,PRIMARY KEY(term,page)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS pages(key TEXT PRIMARY KEY,json TEXT);
      CREATE TABLE IF NOT EXISTS index_pages(seq INTEGER PRIMARY KEY,kind TEXT,key TEXT UNIQUE,json TEXT);`);
    if (staging?.state) {
      this.state = staging.state;
      Object.assign(this.report, this.state.report);
      this.ordinals = new Map(this.state.ordinals);
    }
    this.packer = new PayloadPacker(writer, this.next);
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
    if (geometry)
      row.geometry = await this.packer.add(
        "geometry",
        geometry,
        bucket + "/" + cell,
      );
    if (topology)
      row.topology = await this.packer.add(
        "topology",
        topology,
        bucket + "/" + cell,
      );
    const bytes = encode(row);
    if (bytes.length > 256 * 1024)
      throw new Error(`Source object ${v.id} metadata exceeds 256 KiB`);
    this.db
      .query("INSERT INTO records VALUES(?,?,?,?,NULL)")
      .run(v.id, cell, bucket, Bun.gzipSync(bytes));
    this.bump(this.report.encountered, v.id.split("/")[0]!);
    this.bump(this.report.counts, v.id.split("/")[0]!);
    this.bump(this.report.geometryStatus, v.geometryStatus);
    for (const k of f) this.bump(this.report.facets, k);
    for (const k of Object.keys(v.tags)) this.bump(this.report.tagKeys, k);
  }
  private async page(kind: string, rows: any[]): Promise<Page> {
    this.signal?.throwIfAborted();
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
      if (this.state.phase === "done") return this.report;
      if (this.state.phase === "ingest") {
        progress(
          "ATLAS_PROGRESS " +
            JSON.stringify({
              stage: "semantic-object-index",
              message: "Indexing compact source attributes",
              completed: 0,
              total: 0,
              unit: "objects",
            }),
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS records_spatial ON records(bucket,cell,id)",
        );
        this.state.phase = "packing";
        await this.checkpoint();
      }
      const packingProgress = measuredProgress(
        progress,
        "semantic-object-packing",
        "Packing source objects",
        count,
        "objects",
      );
      let packed = this.state.packed,
        lastBucket: string | undefined;
      let batch: ObjectRecord[] = [],
        size = 0;

      const flush = async () => {
        if (!batch.length) return;
        const p = await this.page("records", batch);

        this.db
          .query("INSERT INTO pages VALUES(?,?)")
          .run(p.key, JSON.stringify(p));
        const tags = new Set<string>();
        for (const row of batch) {
          this.db
            .query("UPDATE records SET page=? WHERE id=?")
            .run(p.key, row.id);
          for (const [key, value] of Object.entries(row.tags))
            tags.add(tagTerm(key, value));
        }
        for (const term of tags)
          this.db.query("INSERT INTO tags VALUES(?,?)").run(term, p.key);
        batch = [];
        size = 0;
      };
      if (this.state.phase === "packing")
        for (const row of this.db
          .query<
            { id: string; cell: number; bucket: string; data: Uint8Array },
            [string, number, string]
          >("SELECT id,cell,bucket,data FROM records WHERE (bucket,cell,id)>(?,?,?) ORDER BY bucket,cell,id")
          .iterate(
            this.state.last?.bucket ?? "",
            this.state.last?.cell ?? -2,
            this.state.last?.id ?? "",
          )) {
          this.signal?.throwIfAborted();
          const json = new TextDecoder().decode(
            Bun.gunzipSync(row.data as Uint8Array<ArrayBuffer>),
          );
          const v: ObjectRecord = JSON.parse(json);
          if (encode(v).length > 256 * 1024)
            throw new Error(`Object ${v.id} metadata exceeds 256 KiB`);
          if (
            batch.length &&
            (lastBucket !== row.bucket ||
              batch.length >= 128 ||
              size + json.length > 192 * 1024 ||
              Boolean(batch[0]?.bounds.length) !== Boolean(v.bounds.length))
          )
            await flush();
          lastBucket = row.bucket;
          batch.push(v);
          size += json.length;
          this.state.last = { bucket: row.bucket, cell: row.cell, id: row.id };
          if (++packed % 10000 === 0) {
            await flush();
            this.state.packed = packed;
            await this.saveProgress(
              progress,
              "semantic-object-packing",
              "Packing source objects",
              packed,
              count,
            );
            packingProgress(packed);
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      await flush();
      if (this.state.phase === "packing") {
        this.state.packed = packed;
        this.state.phase = "lookup";
        await this.saveProgress(
          progress,
          "semantic-object-packing",
          "Packing source objects",
          packed,
          count,
        );
      }
      packingProgress(packed);
      const lookupProgress = measuredProgress(
        progress,
        "semantic-object-lookup",
        "Indexing source identities",
        count,
        "objects",
      );
      let indexed = this.state.indexed;
      let ids: { id: string; page: string }[] = [];
      if (this.state.phase === "lookup")
        for (const row of this.db
          .query<
            { id: string; page: string },
            [string]
          >("SELECT id,page FROM records WHERE id>? ORDER BY id")
          .iterate(this.state.lastId ?? "")) {
          this.signal?.throwIfAborted();
          ids.push(row);
          if (++indexed % 10000 === 0) lookupProgress(indexed);
          if (ids.length === 256) {
            this.remember("ids", await this.page("ids", ids));
            this.state.lastId = row.id;
            this.state.indexed = indexed;
            ids = [];
            if (indexed % 10240 === 0) {
              await this.saveProgress(
                progress,
                "semantic-object-lookup",
                "Indexing source identities",
                indexed,
                count,
              );
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
      if (ids.length) this.remember("ids", await this.page("ids", ids));
      if (this.state.phase === "lookup") {
        this.state.indexed = indexed;
        this.state.phase = "tags";
        await this.saveProgress(
          progress,
          "semantic-object-lookup",
          "Indexing source identities",
          indexed,
          count,
        );
      }
      lookupProgress(indexed);
      const tagProgress = measuredProgress(
        progress,
        "semantic-object-tags",
        "Indexing exact tag values",
        0,
        "terms",
      );
      let indexedTerms = this.state.terms;
      let terms: { term: string; root?: Page; pages?: string[] }[] = [],
        termBytes = 0;
      let term: string | undefined,
        postings: Page[] = [];
      const flushTerms = async () => {
        if (terms.length) {
          this.remember("tags", await this.page("tag-values", terms));
          this.state.lastTerm = terms.at(-1)!.term;
          this.state.terms = indexedTerms;
        }
        terms = [];
        termBytes = 0;
      };
      const flushTerm = async () => {
        if (term === undefined) return;
        tagProgress(indexedTerms);
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
        indexedTerms++;
        termBytes += bytes;
        postings = [];
      };
      // Postings are deduplicated per attribute page when that page is written. No
      // object/tag join or dataset-sized DISTINCT/ORDER BY temporary sort is needed.
      if (this.state.phase === "tags")
        for (const row of this.db
          .query<
            { term: string; json: string },
            [string]
          >("SELECT tags.term,pages.json FROM tags JOIN pages ON pages.key=tags.page WHERE tags.term>? ORDER BY tags.term,tags.page")
          .iterate(this.state.lastTerm ?? "")) {
          this.signal?.throwIfAborted();
          if (row.term !== term) {
            await flushTerm();
            if (indexedTerms && indexedTerms % 10000 === 0) {
              await flushTerms();
              await this.saveProgress(
                progress,
                "semantic-object-tags",
                "Indexing exact tag values",
                indexedTerms,
                0,
                "terms",
              );
              await new Promise((r) => setTimeout(r, 0));
            }
            term = row.term;
          }
          postings.push(JSON.parse(row.json));
        }
      await flushTerm();
      await flushTerms();
      if (this.state.phase === "tags") {
        this.state.phase = "trees";
        await this.saveProgress(
          progress,
          "semantic-object-tags",
          "Indexing exact tag values",
          indexedTerms,
          0,
          "terms",
        );
      }
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
      const tagTree = await this.tree("tag-index", this.remembered("tags"));
      const spatial = await this.tree(
          "spatial",
          this.db
            .query<{ json: string }, []>("SELECT json FROM pages ORDER BY key")
            .all()
            .map((p) => JSON.parse(p.json)),
        ),
        idTree = await this.tree("lookup", this.remembered("ids"));
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
      this.state.phase = "done";
      await this.checkpoint();
      return this.report;
    } finally {
      this.close();
    }
  }
  close() {
    if (!this.closed && !this.staging) {
      this.db.close();
      rmSync(this.path, { force: true });
      this.closed = true;
    }
  }
}
