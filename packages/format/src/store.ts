import type { Block } from "./index";
export interface SavedIndex {
  header: Uint8Array;
  index: Uint8Array;
}
export interface BlockStore {
  available: boolean;
  getIndex(id: string): Promise<SavedIndex | undefined>;
  putIndex(id: string, value: SavedIndex): Promise<void>;
  get(snapshot: string, block: Block): Promise<Uint8Array | undefined>;
  put(snapshot: string, block: Block, bytes: Uint8Array): Promise<void>;
  keys(snapshot: string): Promise<string[]>;
}
const eligible = (key: string) =>
  key.startsWith("tile/") ||
  key.startsWith("labels/") ||
  key.startsWith("index/") ||
  key.startsWith("routing/cells/");
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) => {
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  void completion.catch(() => {});
  return completion;
};
/** Compressed, hash-checked immutable blocks. 128 MiB LRU across all snapshots. */
export class BrowserBlockStore implements BlockStore {
  available = true;
  private queue: Promise<unknown> = Promise.resolve();
  private db: Promise<IDBDatabase>;
  constructor(readonly limit = 128 * 1024 * 1024) {
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open("atlas-blocks-v1", 1);
      r.onupgradeneeded = () => {
        for (const name of ["data", "meta", "indexes"])
          r.result.createObjectStore(name);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    this.db.catch(() => {
      this.available = false;
    });
  }
  private async safe<T>(
    fn: (db: IDBDatabase) => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.available) return;
    try {
      return await fn(await this.db);
    } catch {
      this.available = false;
      return;
    }
  }
  async getIndex(id: string) {
    return this.safe((db) =>
      request<SavedIndex | undefined>(
        db.transaction("indexes").objectStore("indexes").get(id),
      ),
    );
  }
  async putIndex(id: string, value: SavedIndex) {
    await this.safe(async (db) => {
      const tx = db.transaction("indexes", "readwrite"),
        end = done(tx);
      tx.objectStore("indexes").put(value, id);
      await end;
    });
  }
  private id(snapshot: string, b: Block) {
    return `${snapshot}:${b.key}:${b.hash}`;
  }
  async get(snapshot: string, b: Block) {
    if (!eligible(b.key)) return;
    return this.safe(async (db) => {
      const id = this.id(snapshot, b),
        tx = db.transaction(["data", "meta"], "readwrite"),
        end = done(tx);
      const [bytes, meta] = await Promise.all([
        request<Uint8Array | undefined>(tx.objectStore("data").get(id)),
        request<any>(tx.objectStore("meta").get(id)),
      ]);
      if (meta) tx.objectStore("meta").put({ ...meta, used: Date.now() }, id);
      await end;
      return bytes;
    });
  }
  async put(snapshot: string, b: Block, bytes: Uint8Array) {
    if (!eligible(b.key) || bytes.length > this.limit) return;
    const job = this.queue.then(() =>
      this.safe(async (db) => {
        const id = this.id(snapshot, b),
          tx = db.transaction(["data", "meta"], "readwrite"),
          end = done(tx);
        const meta = tx.objectStore("meta");
        const entries = await request<
          Array<{ id: string; bytes: number; used: number }>
        >(meta.getAll());
        let size = entries.reduce(
          (n, e) => n + (e.id === id ? 0 : e.bytes),
          bytes.length,
        );
        for (const e of entries.sort((a, b) => a.used - b.used)) {
          if (size <= this.limit) break;
          if (e.id === id) continue;
          meta.delete(e.id);
          tx.objectStore("data").delete(e.id);
          size -= e.bytes;
        }
        tx.objectStore("data").put(bytes, id);
        meta.put(
          { id, snapshot, key: b.key, bytes: bytes.length, used: Date.now() },
          id,
        );
        await end;
      }),
    );
    this.queue = job.catch(() => {});
    await job;
  }
  async keys(snapshot: string) {
    return (
      (await this.safe(async (db) => {
        const entries = await request<Array<{ snapshot: string; key: string }>>(
          db.transaction("meta").objectStore("meta").getAll(),
        );
        return entries.filter((e) => e.snapshot === snapshot).map((e) => e.key);
      })) ?? []
    );
  }
}
