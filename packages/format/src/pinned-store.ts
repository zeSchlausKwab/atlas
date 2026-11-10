import { sha256, type Block } from "./index";
import type { BlockStore, SavedIndex } from "./store";
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) => {
  const p = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? Error("Storage transaction aborted"));
  });
  void p.catch(() => {});
  return p;
};
export const pinnedKey = (snapshot: string, b: Block) =>
  `${snapshot}:${b.key}:${b.hash}`;
/** Durable saved areas, separate from the disposable LRU. A failed write is an error,
 * never a successful acquisition. Owners allow overlapping areas to share blocks. */
export class PinnedBlockStore {
  private db: Promise<IDBDatabase>;
  constructor() {
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open("atlas-saved-areas-v1", 2);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("data")) {
          r.result.createObjectStore("data");
          const owners = r.result.createObjectStore("owners", {
            keyPath: ["job", "key"],
          });
          owners.createIndex("job", "job");
          owners.createIndex("key", "key");
          owners.createIndex("snapshot", "snapshot");
          r.result.createObjectStore("jobs", { keyPath: "id" });
        }
        r.result.createObjectStore("plans");
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
    });
    void this.db.catch(() => {});
  }
  async get(snapshot: string, b: Block) {
    const db = await this.db;
    return request<Uint8Array | undefined>(
      db.transaction("data").objectStore("data").get(pinnedKey(snapshot, b)),
    );
  }
  async put(job: string, snapshot: string, b: Block, bytes: Uint8Array) {
    const db = await this.db,
      tx = db.transaction(["data", "owners"], "readwrite"),
      end = done(tx),
      key = pinnedKey(snapshot, b);
    tx.objectStore("data").put(bytes, key);
    tx.objectStore("owners").put({ job, key, snapshot, block: b.key });
    await end;
  }
  async keys(snapshot: string) {
    const db = await this.db;
    const rows = await request<Array<{ block: string }>>(
      db
        .transaction("owners")
        .objectStore("owners")
        .index("snapshot")
        .getAll(snapshot),
    );
    return [...new Set(rows.map((r) => r.block))];
  }
  async save<T extends { id: string }>(job: T) {
    const db = await this.db,
      tx = db.transaction("jobs", "readwrite"),
      end = done(tx);
    tx.objectStore("jobs").put(job);
    await end;
  }
  async savePlan(id: string, plan: unknown) {
    const db = await this.db,
      tx = db.transaction("plans", "readwrite"),
      end = done(tx);
    tx.objectStore("plans").put(plan, id);
    await end;
  }
  async plan<T>(id: string) {
    const db = await this.db;
    return request<T | undefined>(
      db.transaction("plans").objectStore("plans").get(id),
    );
  }
  async jobs<T>() {
    const db = await this.db;
    return request<T[]>(db.transaction("jobs").objectStore("jobs").getAll());
  }
  async job<T>(id: string) {
    const db = await this.db;
    return request<T | undefined>(
      db.transaction("jobs").objectStore("jobs").get(id),
    );
  }
  async remove(id: string) {
    const db = await this.db,
      tx = db.transaction(["jobs", "plans", "data", "owners"], "readwrite"),
      end = done(tx),
      owners = tx.objectStore("owners");
    const rows = await request<Array<{ job: string; key: string }>>(
      owners.index("job").getAll(id),
    );
    for (const row of rows) owners.delete([row.job, row.key]);
    for (const row of rows)
      if (!(await request(owners.index("key").count(row.key))))
        tx.objectStore("data").delete(row.key);
    tx.objectStore("jobs").delete(id);
    tx.objectStore("plans").delete(id);
    await end;
  }
  async clear() {
    const db = await this.db,
      tx = db.transaction(["jobs", "plans", "data", "owners"], "readwrite"),
      end = done(tx);
    for (const s of ["jobs", "plans", "data", "owners"])
      tx.objectStore(s).clear();
    await end;
  }
  forJob(id: string, fallback?: BlockStore): BlockStore {
    return {
      available: true,
      getIndex: async (): Promise<SavedIndex | undefined> => undefined,
      putIndex: async () => {},
      get: async (snapshot, b) => {
        const bytes =
          (await this.get(snapshot, b)) ?? (await fallback?.get(snapshot, b));
        if (
          !bytes ||
          bytes.length !== b.length ||
          (await sha256(bytes)) !== b.hash
        )
          return;
        await this.put(id, snapshot, b, bytes);
        return bytes;
      },
      put: (snapshot, b, bytes) => this.put(id, snapshot, b, bytes),
      keys: (snapshot) => this.keys(snapshot),
    };
  }
}
