import { Database } from "bun:sqlite";
import { normalize, type Location } from "./model";
import { grams, termBucket } from "./paging";

// Bound the accumulator by postings, not source records (aliases vary in size).
const MAX_PENDING = 262144;
export interface PostingChunk {
  first: number;
  count: number;
  data: Uint8Array;
}

/** Temporary compiler data only. The published postings-v1 pages stay unchanged. */
export function encodePostingChunk(ids: number[]): Uint8Array {
  const raw = new Uint8Array(ids.length * 4);
  const view = new DataView(raw.buffer);
  let previous = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id >= 2 ** 32 ||
      (i > 0 && id <= previous)
    )
      throw new Error(
        "Search postings must have strictly increasing uint32 identities",
      );
    view.setUint32(i * 4, id - previous, true);
    previous = id;
  }
  const zipped = Bun.gzipSync(raw);
  const compressed = zipped.length < raw.length;
  const body = compressed ? zipped : raw;
  const output = new Uint8Array(body.length + 1);
  output[0] = compressed ? 1 : 0;
  output.set(body, 1);
  return output;
}

export function decodePostingChunk(chunk: PostingChunk): Uint32Array {
  if (
    !Number.isInteger(chunk.count) ||
    chunk.count < 1 ||
    chunk.count > MAX_PENDING ||
    !Number.isInteger(chunk.first) ||
    chunk.first < 0 ||
    chunk.first >= 2 ** 32
  )
    throw new Error("Invalid search posting chunk metadata");
  const raw =
    chunk.data[0] === 0
      ? chunk.data.subarray(1)
      : chunk.data[0] === 1
        ? Bun.gunzipSync(chunk.data.subarray(1) as Uint8Array<ArrayBuffer>)
        : undefined;
  if (!raw || raw.length !== chunk.count * 4)
    throw new Error("Invalid search posting chunk payload");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const ids = new Uint32Array(chunk.count);
  let id = 0;
  for (let i = 0; i < chunk.count; i++) {
    const delta = view.getUint32(i * 4, true);
    id += delta;
    if (
      (i > 0 && delta === 0) ||
      id >= 2 ** 32 ||
      (i === 0 && id !== chunk.first)
    )
      throw new Error("Invalid search posting chunk identities");
    ids[i] = id;
  }
  return ids;
}

/** One ordered row per term/batch, instead of a row and a second index per gram.
 * Delta-compressed IDs keep common address/context text cheap. SQLite stays local.
 */
export class PostingSpool {
  private pending = new Map<string, number[]>();
  private pendingCount = 0;
  private lastRecord = -1;
  count = 0;
  constructor(private db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS postings(
      bucket INTEGER, term TEXT, first INTEGER, count INTEGER, data BLOB,
      PRIMARY KEY(bucket,term,first)) WITHOUT ROWID`);
  }
  add(record: Location, rid: number) {
    if (!Number.isInteger(rid) || rid <= this.lastRecord || rid >= 2 ** 32)
      throw new Error("Search records must arrive in ordinal order");
    this.lastRecord = rid;
    const terms = grams(
      [record.name, ...record.aliases, record.context ?? ""]
        .map(normalize)
        .join(" "),
    );
    for (const gram of grams(
      [record.name, ...record.aliases].map(normalize).join(" "),
    ))
      terms.add("n:" + gram);
    for (const term of terms) {
      let ids = this.pending.get(term);
      if (!ids) this.pending.set(term, (ids = []));
      ids.push(rid);
      this.pendingCount++;
      this.count++;
    }
    if (this.pendingCount >= MAX_PENDING) this.flush();
  }
  flush() {
    const insert = this.db.query("INSERT INTO postings VALUES(?,?,?,?,?)");
    for (const [term, ids] of this.pending)
      insert.run(
        termBucket(term),
        term,
        ids[0]!,
        ids.length,
        encodePostingChunk(ids),
      );
    this.pending.clear();
    this.pendingCount = 0;
  }
}
