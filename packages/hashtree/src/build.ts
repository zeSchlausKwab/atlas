import { Database } from "bun:sqlite";
import { open, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { encodeAndHash, LinkType, toHex, type Link } from "@hashtree/core";
import { CHUNK_BYTES, FANOUT, HASH, MAX_BLOB_BYTES } from "./source";
export interface TreeIndex {
  version: 1;
  root: string;
  bytes: number;
  chunkBytes: number;
  fileHash: string;
  path: string;
  fingerprint: string;
  blocks: number;
}
function fingerprint(s: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}) {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}
/** Leaf bytes remain in the .atlas. SQLite holds offsets and small standard file nodes. */
export async function buildTreeIndex(
  path: string,
  output: string,
  options: {
    chunkBytes?: number;
    signal?: AbortSignal;
    progress?: (bytes: number, total: number) => void;
  } = {},
): Promise<TreeIndex> {
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  if (
    !Number.isInteger(chunkBytes) ||
    chunkBytes < 16384 ||
    chunkBytes > MAX_BLOB_BYTES
  )
    throw new Error("Invalid chunk size");
  const handle = await open(path, "r"),
    before = await handle.stat({ bigint: true });
  const bytes = Number(before.size),
    part = output + ".part";
  if (!before.isFile() || !Number.isSafeInteger(bytes) || bytes <= 0) {
    await handle.close();
    throw new Error("Invalid file");
  }
  await rm(part, { force: true });
  const db = new Database(part, { create: true });
  db.run(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE blobs(hash TEXT PRIMARY KEY, start INTEGER, length INTEGER, data BLOB); CREATE TABLE meta(json TEXT);",
  );
  const put = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?, ?, ?)");
  const hash = createHash("sha256");
  // Each level holds at most FANOUT links, independent of archive size.
  const levels: Link[][] = [];
  let blocks = 0;
  const node = async (links: Link[]): Promise<Link> => {
    const encoded = await encodeAndHash({ type: LinkType.File, links });
    put.run(toHex(encoded.hash), null, encoded.data.length, encoded.data);
    blocks++;
    return {
      hash: encoded.hash,
      size: links.reduce((n, l) => n + l.size, 0),
      type: LinkType.File,
    };
  };
  const push = async (link: Link, level = 0): Promise<void> => {
    const links = (levels[level] ??= []);
    links.push(link);
    if (links.length === FANOUT) {
      const parent = await node(links.splice(0));
      await push(parent, level + 1);
    }
  };
  try {
    db.run("BEGIN");
    for (let at = 0; at < bytes; at += chunkBytes) {
      options.signal?.throwIfAborted();
      const data = new Uint8Array(Math.min(chunkBytes, bytes - at));
      let read = 0;
      while (read < data.length) {
        const r = await handle.read(data, read, data.length - read, at + read);
        if (!r.bytesRead) throw new Error("Truncated source");
        read += r.bytesRead;
      }
      hash.update(data);
      const digest = createHash("sha256").update(data).digest();
      put.run(digest.toString("hex"), at, data.length, null);
      blocks++;
      await push({ hash: digest, size: data.length, type: LinkType.Blob });
      if (blocks % 1000 === 0) {
        db.run("COMMIT; BEGIN");
        options.progress?.(at + data.length, bytes);
      }
    }
    let root: Link | undefined;
    for (let level = 0; level < levels.length; level++) {
      const links = levels[level]!;
      if (!links.length) continue;
      const link = links.length === 1 ? links[0]! : await node(links.splice(0));
      if (levels.slice(level + 1).some((l) => l.length))
        await push(link, level + 1);
      else {
        root = link;
        break;
      }
    }
    if (!root || root.size !== bytes) throw new Error("Invalid tree size");
    if (
      fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)
    )
      throw new Error("Source changed while indexing");
    const info: TreeIndex = {
      version: 1,
      root: toHex(root.hash),
      bytes,
      chunkBytes,
      fileHash: hash.digest("hex"),
      path,
      fingerprint: fingerprint(before),
      blocks,
    };
    db.prepare("INSERT INTO meta VALUES (?)").run(JSON.stringify(info));
    db.run("COMMIT");
    db.close();
    await rename(part, output);
    options.progress?.(bytes, bytes);
    return info;
  } catch (error) {
    try {
      db.close();
    } catch {}
    await rm(part, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
export class IndexedTree {
  private constructor(
    readonly db: Database,
    readonly info: TreeIndex,
  ) {}
  static open(path: string) {
    const db = new Database(path, { readonly: true });
    try {
      const record = db.prepare("SELECT json FROM meta").get() as {
        json: string;
      };
      const info = JSON.parse(record.json) as TreeIndex;
      if (info.version !== 1 || !HASH.test(info.root))
        throw new Error("Invalid tree index");
      return new IndexedTree(db, info);
    } catch (e) {
      db.close();
      throw e;
    }
  }
  async assertUnchanged() {
    if (
      fingerprint(await stat(this.info.path, { bigint: true })) !==
      this.info.fingerprint
    )
      throw new Error("Indexed map changed; republish it");
  }
  async get(hash: string): Promise<Uint8Array | null> {
    if (!HASH.test(hash)) return null;
    await this.assertUnchanged();
    const r = this.db
      .prepare("SELECT start, length, data FROM blobs WHERE hash=?")
      .get(hash) as {
      start: number | null;
      length: number;
      data: Uint8Array | null;
    } | null;
    if (!r) return null;
    if (r.data) return r.data;
    const bytes = new Uint8Array(
      await Bun.file(this.info.path)
        .slice(r.start!, r.start! + r.length)
        .arrayBuffer(),
    );
    await this.assertUnchanged();
    if (
      bytes.length !== r.length ||
      createHash("sha256").update(bytes).digest("hex") !== hash
    )
      throw new Error("Indexed map block changed");
    return bytes;
  }
  close() {
    this.db.close();
  }
}
