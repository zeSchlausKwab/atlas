import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Preparations } from "../apps/server/preparations";
import {
  ArchiveUploads,
  UPLOAD_CHUNK_BYTES,
} from "../apps/server/archive-uploads";
import { importArchive } from "../apps/server/archive-import";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { pluginFixture } from "./helpers/plugin-fixture";
async function setup() {
  const dir = await mkdtemp("/tmp/atlas-archive-"),
    fixture = await pluginFixture();
  await Bun.write(dir + "/source.atlas", fixture.bytes);
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    fixture.reader.index.manifest,
  );
  let uploads = await ArchiveUploads.open(dir + "/uploads", manager);
  const call = (
    path = "",
    method = "GET",
    body?: BodyInit,
    origin = "http://localhost",
  ) =>
    uploads.handle(
      new Request(`http://localhost/admin/imports${path}`, {
        method,
        headers: { Origin: origin },
        body,
      }),
      "127.0.0.1",
    );
  return {
    dir,
    fixture,
    manager,
    call,
    restartUploads: async () => {
      uploads = await ArchiveUploads.open(dir + "/uploads", manager);
    },
    create: async (filename: string, size: number) => {
      const r = await call("", "POST", JSON.stringify({ filename, size }));
      expect(r.status).toBe(201);
      return r.json();
    },
    close: async () => {
      await manager.close();
      fixture.engine.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  const end = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > end) throw new Error("Import timed out");
    await Bun.sleep(10);
  }
}
test("archive uploads enforce origin, filenames, declared length and acknowledged offsets", async () => {
  const s = await setup();
  try {
    expect((await s.call("", "POST", "{}", "http://evil.test")).status).toBe(
      403,
    );
    for (const filename of ["../evil.atlas", "x/y.mbtiles", "hello.png"])
      expect(
        (await s.call("", "POST", JSON.stringify({ filename, size: 20 })))
          .status,
      ).toBe(400);
    const u = await s.create("example.atlas", 8);
    expect((await s.call(`/${u.id}/finish`, "POST")).status).toBe(400);
    expect(
      (await s.call(`/${u.id}?offset=1`, "PUT", new Uint8Array(4))).status,
    ).toBe(409);
    expect(
      (await s.call(`/${u.id}?offset=0`, "PUT", new Uint8Array(9))).status,
    ).toBe(400);
    expect(
      (await s.call(`/${u.id}?offset=0`, "PUT", new Uint8Array(4))).status,
    ).toBe(200);
    expect((await (await s.call(`/${u.id}`)).json()).offset).toBe(4);
    expect(
      (await s.call(`/${u.id}?offset=0`, "PUT", new Uint8Array(4))).status,
    ).toBe(409);
    expect((await s.call(`/${u.id}`, "DELETE")).status).toBe(200);
    expect(await Bun.file(`${s.dir}/uploads/${u.id}.upload`).exists()).toBe(
      false,
    );
    const big = await s.create("chunk.atlas", UPLOAD_CHUNK_BYTES + 1);
    expect(
      (
        await s.call(
          `/${big.id}?offset=0`,
          "PUT",
          new Uint8Array(UPLOAD_CHUNK_BYTES + 1),
        )
      ).status,
    ).toBe(400);
  } finally {
    await s.close();
  }
});
test("interrupted upload recovers acknowledged offset and Atlas registration preserves every byte", async () => {
  const s = await setup();
  try {
    const bytes = new Uint8Array(s.fixture.bytes),
      u = await s.create("original.atlas", bytes.length),
      half = Math.floor(bytes.length / 2);
    await s.call(`/${u.id}?offset=0`, "PUT", bytes.slice(0, half));
    // Crash after writing, before committing the offset: truncate unacknowledged tail on recovery.
    await Bun.write(`${s.dir}/uploads/${u.id}.upload`, bytes);
    await s.restartUploads();
    expect((await stat(`${s.dir}/uploads/${u.id}.upload`)).size).toBe(half);
    expect((await (await s.call()).json()).uploads[0].offset).toBe(half);
    expect(
      (await s.call(`/${u.id}?offset=${half}`, "PUT", bytes.slice(half)))
        .status,
    ).toBe(200);
    const queued = await s.call(`/${u.id}/finish`, "POST");
    expect(queued.status).toBe(202);
    expect((await queued.json()).jobId).toBe(u.id);
    expect(
      (
        await s.call(
          `/${u.id}?offset=${bytes.length}`,
          "PUT",
          new Uint8Array(1),
        )
      ).status,
    ).toBe(400);
    await until(() =>
      ["failed", "ready"].includes(s.manager.jobs.get(u.id)!.state),
    );
    const job = s.manager.jobs.get(u.id)!;
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    expect(job.manifest).toEqual(s.fixture.reader.index.manifest);
    expect(
      new Uint8Array(await Bun.file(s.manager.path(u.id)).arrayBuffer()),
    ).toEqual(bytes);
    expect((await (await s.call(`/${u.id}/finish`, "POST")).json()).jobId).toBe(
      u.id,
    );
    expect(s.manager.jobs.size).toBe(1);
    expect(await Bun.file(`${s.dir}/uploads/${u.id}.upload`).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(`${s.dir}/hosted/${u.id}.work/input.atlas`).exists(),
    ).toBe(false);
    await s.manager.close();
    const reopened = await Preparations.open(
      s.dir + "/hosted",
      s.dir + "/source.atlas",
      s.fixture.reader.index.manifest,
    );
    try {
      expect(reopened.catalog()[0]?.id).toBe(u.id);
      await reopened.delete(u.id);
    } finally {
      await reopened.close();
    }
    expect(await Bun.file(s.manager.path(u.id)).exists()).toBe(false);
    expect(await Bun.file(s.dir + "/source.atlas").exists()).toBe(true);
  } finally {
    await s.close();
  }
}, 15000);
test("MBTiles upload joins the preparation queue and advertises usable JPEG imagery", async () => {
  const s = await setup();
  try {
    const db = new Database(s.dir + "/test.mbtiles"),
      jpeg = new Uint8Array(
        await Bun.file(
          new URL("fixtures/raster/white-256.jpg", import.meta.url),
        ).arrayBuffer(),
      );
    db.run(
      "CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB)",
    );
    for (const [k, v] of Object.entries({
      name: "Uploaded satellite",
      format: "jpg",
      bounds: "0,0,10,10",
      attribution: "Test author",
      license: "CC0",
    }))
      db.query("INSERT INTO metadata VALUES (?,?)").run(k, v);
    db.query("INSERT INTO tiles VALUES (0,0,0,?)").run(jpeg);
    db.close();
    const bytes = new Uint8Array(
        await Bun.file(s.dir + "/test.mbtiles").arrayBuffer(),
      ),
      u = await s.create("test.mbtiles", bytes.length);
    expect((await s.call(`/${u.id}?offset=0`, "PUT", bytes)).status).toBe(200);
    expect((await s.call(`/${u.id}/finish`, "POST")).status).toBe(202);
    await until(() =>
      ["ready", "failed"].includes(s.manager.jobs.get(u.id)!.state),
    );
    const job = s.manager.jobs.get(u.id)!;
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    expect(job.name).toBe("Uploaded satellite");
    expect(job.manifest?.capabilities).toContain("raster-rendering");
    const reader = await new AtlasReader(
      new FileSource(Bun.file(s.manager.path(u.id))),
    ).open();
    const layer = reader.index.manifest.rasters![0]!;
    expect(layer.encoding).toBe("jpeg");
    expect(layer.mbtiles?.filename).toBe("test.mbtiles");
    expect(layer.source.url).toBe("mbtiles:test.mbtiles");
    expect(await reader.block(`raster/${layer.id}/0/0/0`)).toEqual(jpeg);
    reader.dispose();
  } finally {
    await s.close();
  }
}, 15000);
test("corrupt archives fail verification, remain resumable, and are never advertised", async () => {
  const s = await setup();
  try {
    const bytes = new Uint8Array(s.fixture.bytes),
      block = (await s.fixture.reader.allBlocks())[0]!;
    bytes[s.fixture.reader.index.header.payloadOffset + block.offset] ^= 255;
    const u = await s.create("corrupt.atlas", bytes.length);
    await s.call(`/${u.id}?offset=0`, "PUT", bytes);
    await s.call(`/${u.id}/finish`, "POST");
    await until(() => s.manager.jobs.get(u.id)!.state === "failed");
    const job = s.manager.jobs.get(u.id)!;
    expect(job.error).toContain("Corrupt Atlas block");
    expect(s.manager.catalog()).toHaveLength(0);
    expect(await Bun.file(s.manager.path(u.id)).exists()).toBe(false);
    expect(
      await Bun.file(`${s.dir}/hosted/${u.id}.work/input.atlas`).exists(),
    ).toBe(true);
    await s.manager.resume(u.id);
    await until(() => s.manager.jobs.get(u.id)!.state === "failed");
    expect(s.manager.jobs.get(u.id)!.error).toContain("Corrupt Atlas block");
    await s.manager.close(); // Wait for the terminal state and checkpoint to settle on disk.
    await s.manager.delete(u.id);
    expect(
      await Bun.file(`${s.dir}/hosted/${u.id}.work/input.atlas`).exists(),
    ).toBe(false);
  } finally {
    await s.close();
  }
}, 15000);
test("archive verification supports cancellation before publication", async () => {
  const s = await setup();
  try {
    const abort = new AbortController();
    await expect(
      importArchive(
        s.dir + "/source.atlas",
        s.dir + "/cancelled.atlas",
        {
          filename: "source.atlas",
          size: s.fixture.bytes.length,
          format: "atlas",
        },
        abort.signal,
        (p) => {
          if (p.completed > 0) abort.abort();
        },
      ),
    ).rejects.toThrow();
    expect(await Bun.file(s.dir + "/cancelled.atlas").exists()).toBe(false);
    expect(await Bun.file(s.dir + "/source.atlas").exists()).toBe(true);
  } finally {
    await s.close();
  }
});
