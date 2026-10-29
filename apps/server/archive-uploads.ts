import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { resolve } from "node:path";
import { adminAccess, ADMIN_DENIED, type AdminAccess } from "./admin-access";
import { limitedBody } from "./request-body";
import { readStorage } from "./storage";
import {
  checkStorageEstimate,
  DISK_RESERVE,
  StorageWarning,
} from "../../packages/provisioning/src/capacity";
import type { ArchiveImport } from "./archive-import";
import type { Preparations } from "./preparations";
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export interface ArchiveUpload extends ArchiveImport {
  id: string;
  modified: number;
  offset: number;
  createdAt: string;
  allowStorageRisk: boolean;
  jobId?: string;
}
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
/** Durable, offset-acknowledged uploads. Paths are generated here, never supplied by clients. */
export class ArchiveUploads {
  private records = new Map<string, ArchiveUpload>();
  private busy = new Set<string>();
  private constructor(
    readonly directory: string,
    private preparations: Preparations,
    private access: AdminAccess,
  ) {}
  static async open(
    directory: string,
    preparations: Preparations,
    access: AdminAccess = adminAccess(),
  ) {
    await mkdir(directory, { recursive: true });
    const uploads = new ArchiveUploads(directory, preparations, access);
    for (const name of await readdir(directory)) {
      const id = name.replace(/\.json$/, "");
      if (name !== `${id}.json` || !validId(id)) continue;
      const record = (await Bun.file(
        resolve(directory, name),
      ).json()) as ArchiveUpload;
      if (record.id !== id) throw new Error("Invalid upload record");
      if (preparations.jobs.has(id)) {
        record.jobId = id;
        await uploads.save(record);
        await rm(uploads.path(id), { force: true });
      } else if (!record.jobId) {
        const size = (await stat(uploads.path(id))).size;
        if (size < record.offset)
          throw new Error("Uploaded file is shorter than its checkpoint");
        await truncate(uploads.path(id), record.offset);
      }
      uploads.records.set(id, record);
    }
    return uploads;
  }
  private path(id: string) {
    return resolve(this.directory, `${id}.upload`);
  }
  private async save(record: ArchiveUpload) {
    const path = resolve(this.directory, `${record.id}.json`);
    await Bun.write(path + ".tmp", JSON.stringify(record));
    await rename(path + ".tmp", path);
  }
  private view(record: ArchiveUpload) {
    return { ...record, chunkBytes: UPLOAD_CHUNK_BYTES };
  }
  async handle(request: Request, remote?: string): Promise<Response> {
    const url = new URL(request.url),
      tail = url.pathname.slice("/admin/imports".length);
    if (
      !this.access(request, remote) ||
      (request.method !== "GET" && request.headers.get("Origin") !== url.origin)
    )
      return Response.json({ error: ADMIN_DENIED }, { status: 403 });
    let lock: string | undefined;
    try {
      if (tail === "" && request.method === "GET")
        return Response.json(
          {
            uploads: [...this.records.values()]
              .filter((r) => !r.jobId)
              .map((r) => this.view(r)),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (tail === "" && request.method === "POST") {
        const value = JSON.parse(
          new TextDecoder().decode(await limitedBody(request, 16384)),
        );
        const {
          filename,
          size,
          modified = 0,
          allowStorageRisk = false,
        } = value;
        if (
          typeof filename !== "string" ||
          !/\.(atlas|mbtiles)$/i.test(filename) ||
          filename.length > 255 ||
          /[\\/\x00-\x1f]/.test(filename)
        )
          throw new Error("Choose an .atlas or raster .mbtiles file");
        if (
          !Number.isSafeInteger(size) ||
          size <= 0 ||
          !Number.isSafeInteger(modified) ||
          modified < 0 ||
          typeof allowStorageRisk !== "boolean"
        )
          throw new Error("Invalid upload size or metadata");
        const format = filename.toLowerCase().endsWith(".atlas")
          ? "atlas"
          : "mbtiles";
        checkStorageEstimate(
          DISK_RESERVE + size * (format === "mbtiles" ? 3.2 : 1),
          (await readStorage(this.directory)).availableBytes,
          allowStorageRisk,
        );
        const record: ArchiveUpload = {
          id: crypto.randomUUID(),
          filename,
          size,
          modified,
          format,
          offset: 0,
          createdAt: new Date().toISOString(),
          allowStorageRisk,
        };
        await Bun.write(this.path(record.id), new Uint8Array());
        await this.save(record);
        this.records.set(record.id, record);
        return Response.json(this.view(record), { status: 201 });
      }
      const match = /^\/([a-f0-9-]{36})(\/finish)?$/.exec(tail);
      const record = match ? this.records.get(match[1]!) : undefined;
      if (!record)
        return Response.json({ error: "Upload not found" }, { status: 404 });
      if (request.method === "GET" && !match![2])
        return Response.json(this.view(record), {
          headers: { "Cache-Control": "no-store" },
        });
      if (this.busy.has(record.id))
        return Response.json(
          { error: "Upload is busy; retry shortly" },
          { status: 409 },
        );
      lock = record.id;
      this.busy.add(lock);
      if (request.method === "DELETE" && !match![2]) {
        if (record.jobId || this.preparations.jobs.has(record.id))
          throw new Error(
            "File is already queued. Manage it in Builds & checkpoints.",
          );
        await rm(resolve(this.directory, `${record.id}.json`), { force: true });
        this.records.delete(record.id);
        await rm(this.path(record.id), { force: true });
        return Response.json({ deleted: true });
      }
      if (request.method === "PUT" && !match![2]) {
        if (record.jobId || this.preparations.jobs.has(record.id))
          throw new Error("Upload already queued");
        const offset = url.searchParams.get("offset");
        if (
          offset === null ||
          !/^\d+$/.test(offset) ||
          Number(offset) !== record.offset
        )
          return Response.json(
            {
              error: "Upload offset changed; refresh before resuming",
              offset: record.offset,
            },
            { status: 409 },
          );
        const bytes = await limitedBody(
          request,
          Math.min(UPLOAD_CHUNK_BYTES, record.size - record.offset),
        );
        if (!bytes.length) throw new Error("Empty upload chunk");
        if (
          (await readStorage(this.directory)).availableBytes - bytes.length <
          DISK_RESERVE
        )
          return Response.json(
            {
              error:
                "Upload paused to preserve 10 GiB free. Free space and resume; received bytes are kept.",
            },
            { status: 507 },
          );
        const file = await open(this.path(record.id), "r+");
        const next = { ...record, offset: record.offset + bytes.length };
        try {
          await file.truncate(record.offset);
          let written = 0;
          while (written < bytes.length) {
            const { bytesWritten } = await file.write(
              bytes,
              written,
              bytes.length - written,
              record.offset + written,
            );
            if (!bytesWritten) throw new Error("Could not write upload");
            written += bytesWritten;
          }
          await file.sync();
          await this.save(next);
          Object.assign(record, next);
        } finally {
          await file.close();
        }
        return Response.json(this.view(record));
      }
      if (request.method === "POST" && match![2]) {
        if (record.offset !== record.size)
          throw new Error("Upload is not complete");
        const job = await this.preparations.createArchive(
          record.id,
          this.path(record.id),
          record,
          record.allowStorageRisk,
        );
        record.jobId = job.id;
        await this.save(record);
        await rm(this.path(record.id), { force: true });
        return Response.json({ jobId: job.id }, { status: 202 });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (error) {
      return Response.json(
        error instanceof StorageWarning
          ? { error: error.message, storageWarning: error.storageWarning }
          : { error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof StorageWarning ? 409 : 400 },
      );
    } finally {
      if (lock) this.busy.delete(lock);
    }
  }
}
