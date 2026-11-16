import { Database } from "bun:sqlite";
import type { Polygon, MultiPolygon } from "geojson";
import type { MapFeature, Bounds } from "../../features/src/index";
import type { BlockWriter } from "../../cli/src/stream-writer";
import { boundaryKey } from "./index";
import {
  BORDER_ROOT,
  BORDER_PAGE_BYTES,
  borderMinZoom,
  simplifyBorder,
  type Border,
  type BorderPage,
} from "./display";

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** Disk-backed spatial ordering: neither the world's geometries nor its metadata
 * have to be accumulated in memory. SQLite owns and removes this temporary file. */
export class BorderDisplayWriter {
  private db = new Database("");
  count = 0;
  private closed = false;
  constructor(private writer: BlockWriter) {
    this.db.run(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; CREATE TABLE borders(level INTEGER, cell INTEGER, id TEXT, data TEXT); BEGIN;",
    );
  }
  add(f: MapFeature) {
    const level = Number(f.properties.tags.admin_level);
    if (!Number.isInteger(level) || level < 1 || level > 12) return;
    const g = f.geometry as Polygon | MultiPolygon;
    const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    let lines: [number, number][][] = [],
      points = 0;
    const flush = () => {
      if (!lines.length) return;
      const bbox: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const line of lines)
        for (const p of line) {
          bbox[0] = Math.min(bbox[0], p[0]);
          bbox[1] = Math.min(bbox[1], p[1]);
          bbox[2] = Math.max(bbox[2], p[0]);
          bbox[3] = Math.max(bbox[3], p[1]);
        }
      const border: Border = { id: f.id, level, bbox, lines };
      const x = Math.floor(((bbox[0] + bbox[2] + 360) / 720) * 256);
      const y = Math.floor(((bbox[1] + bbox[3] + 170) / 340) * 256);
      const data = JSON.stringify(border);
      if (encode(border).length > BORDER_PAGE_BYTES - 128)
        throw new Error(`Border ${f.id} exceeds the display page budget`);
      this.db
        .query("INSERT INTO borders VALUES (?,?,?,?)")
        .run(level, y * 256 + x, f.id, data);
      if (++this.count % 10000 === 0) this.db.run("COMMIT; BEGIN;");
      lines = [];
      points = 0;
    };
    // Long rings are split with a shared endpoint. No lines are discarded and
    // even a continent-sized polygon cannot produce an unbounded display block.
    for (const polygon of polygons)
      for (const ring of polygon) {
        for (const line of simplifyBorder(ring, borderMinZoom(level) + 5)) {
          for (let at = 0; at < line.length - 1; at += 4095) {
            const part = line.slice(at, at + 4096);
            if (points + part.length > 4096) flush();
            lines.push(part);
            points += part.length;
          }
        }
      }
    flush();
  }
  async finish() {
    this.db.run("COMMIT");
    const pages: BorderPage[] = [];
    let borders: Border[] = [],
      size = 0,
      level = 0,
      cell = -1;
    const flush = async () => {
      if (!borders.length) return;
      const bbox: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const b of borders) {
        bbox[0] = Math.min(bbox[0], b.bbox[0]);
        bbox[1] = Math.min(bbox[1], b.bbox[1]);
        bbox[2] = Math.max(bbox[2], b.bbox[2]);
        bbox[3] = Math.max(bbox[3], b.bbox[3]);
      }
      const key = boundaryKey("records", pages.length).replace(
        "boundaries/records/",
        "boundary-display/",
      );
      const bytes = encode({ schema: "boundary-lines-v1", borders });
      if (bytes.length > BORDER_PAGE_BYTES)
        throw new Error("Administrative display page exceeds 1 MiB");
      await this.writer.add({ key, bytes, features: borders.length });
      pages.push({ key, bbox, level, count: borders.length });
      borders = [];
      size = 0;
    };
    try {
      for (const row of this.db
        .query<
          { level: number; cell: number; data: string },
          []
        >("SELECT level,cell,data FROM borders ORDER BY level,cell,id")
        .iterate()) {
        if (
          borders.length &&
          (row.level !== level ||
            (row.cell !== cell && borders.length >= 16) ||
            borders.length >= 64 ||
            size + row.data.length > 240 * 1024)
        )
          await flush();
        level = row.level;
        cell = row.cell;
        size += row.data.length + 1;
        borders.push(JSON.parse(row.data));
      }
      await flush();
      const index = encode({
        schema: "boundary-display-v1",
        count: this.count,
        pages,
      });
      if (index.length > 16 * 1024 ** 2 || pages.length > 100000)
        throw new Error("Administrative display index exceeds its budget");
      await this.writer.add({
        key: BORDER_ROOT,
        bytes: index,
        features: this.count,
      });
    } finally {
      this.close();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
