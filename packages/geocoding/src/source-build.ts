import { Database } from "bun:sqlite";
import type { FeatureCollection } from "geojson";
import { buildGeocoding } from "./compile";
import { meters, type Location, type Position } from "./model";
import { PagedSearchBuilder } from "./paged-build";
const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
/** Resolves settlement context and street groups across every source partition. */
export class SourceGeocoding {
  private groups: Database;
  constructor(
    readonly source: Database,
    readonly output: Pick<PagedSearchBuilder, "addLocation" | "addStreet">,
    readonly path: string,
  ) {
    this.groups = new Database(path);
    this.groups
      .run(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384;
      CREATE TABLE groups(key TEXT PRIMARY KEY,distance REAL,json TEXT) WITHOUT ROWID; BEGIN;`);
  }
  nearby = (point: Position): Location | undefined => {
    const dy = ((10000 / 6371000) * 180) / Math.PI,
      dx =
        (Math.asin(
          Math.sin(10000 / 6371000) / Math.cos((point[1] * Math.PI) / 180),
        ) *
          180) /
        Math.PI;
    let best: Location | undefined,
      distance = Infinity;
    const rows = this.source
      .query<{ json: string }, [number, number, number, number]>(
        `SELECT l.json FROM places p JOIN locations l ON l.id=p.id
      WHERE p.x1>=? AND p.x0<=? AND p.y1>=? AND p.y0<=? ORDER BY l.id`,
      )
      .iterate(point[0] - dx, point[0] + dx, point[1] - dy, point[1] + dy);
    for (const { json } of rows) {
      const r: Location = JSON.parse(json),
        d = meters(point, r.coordinates);
      if (d < distance) {
        distance = d;
        best = r;
      }
    }
    return distance <= 10000 ? best : undefined;
  };
  async addNodes(signal?: AbortSignal) {
    let count = 0;
    for (const { json } of this.source
      .query<{ json: string }, []>("SELECT json FROM locations ORDER BY id")
      .iterate()) {
      signal?.throwIfAborted();
      if (++count % 10000 === 0) await new Promise((r) => setTimeout(r, 0));
      for (const r of buildGeocoding([JSON.parse(json)], empty, {
        nearby: this.nearby,
      }).locations.records)
        this.output.addLocation(r);
    }
  }
  addFeatures(features: FeatureCollection) {
    const { locations, streets } = buildGeocoding([], features, {
      nearby: this.nearby,
      group: (key, r, d) => {
        const old = this.groups
          .query<
            { distance: number; json: string },
            [string]
          >("SELECT distance,json FROM groups WHERE key=?")
          .get(key);
        if (old) {
          const previous: Location = JSON.parse(old.json),
            keep = d < old.distance ? r : previous;
          keep.aliases = [
            ...new Set([...previous.aliases, ...r.aliases]),
          ].sort();
          r = keep;
          d = Math.min(d, old.distance);
        }
        this.groups
          .query(
            "INSERT INTO groups VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET distance=excluded.distance,json=excluded.json",
          )
          .run(key, d, JSON.stringify(r));
      },
    });
    for (const r of locations.records) this.output.addLocation(r);
    for (const s of streets.streets) this.output.addStreet(s);
  }
  async finish(signal?: AbortSignal) {
    let count = 0;
    this.groups.run("COMMIT");
    for (const { json } of this.groups
      .query<{ json: string }, []>("SELECT json FROM groups ORDER BY key")
      .iterate()) {
      signal?.throwIfAborted();
      this.output.addLocation(JSON.parse(json));
      if (++count % 10000 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  close() {
    this.groups.close();
  }
}
