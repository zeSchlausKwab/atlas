import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256, type Block } from "../../packages/format/src/index";
import type { BlockStore, SavedIndex } from "../../packages/format/src/store";
/** Durable, content-addressed acquisition cache. Never evicts a paused job's blocks. */
export class AcquisitionCache implements BlockStore {
  available = true;
  constructor(
    readonly directory: string,
    private beforeWrite = async (_bytes: number) => {},
  ) {}
  private path(b: Block) {
    if (!/^[a-f0-9]{64}$/.test(b.hash)) throw Error("Invalid cache hash");
    return join(this.directory, b.hash.slice(0, 2), b.hash);
  }
  async has(b: Block) {
    try {
      const s = await stat(this.path(b));
      return b.length === 0 || s.size === b.length;
    } catch {
      return false;
    }
  }
  async get(_snapshot: string, b: Block) {
    const path = this.path(b);
    if (!(await Bun.file(path).exists())) return;
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    if ((await sha256(bytes)) === b.hash) return bytes;
    await rm(path, { force: true }); // damaged cache is fetched again, never trusted
  }
  async put(_snapshot: string, b: Block, bytes: Uint8Array) {
    if ((await sha256(bytes)) !== b.hash)
      throw Error("Acquisition cache integrity failure");
    const path = this.path(b);
    if (await this.has({ ...b, length: bytes.length })) return;
    await this.beforeWrite(bytes.length);
    await mkdir(join(this.directory, b.hash.slice(0, 2)), { recursive: true });
    const tmp = path + "." + crypto.randomUUID() + ".tmp";
    try {
      const f = await open(tmp, "wx");
      try {
        await f.writeFile(bytes);
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async getIndex(_id: string): Promise<SavedIndex | undefined> {
    return undefined;
  }
  async putIndex(_id: string, _value: SavedIndex) {}
  async keys(_snapshot: string): Promise<string[]> {
    return [];
  }
}
