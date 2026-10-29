import { test, expect } from "bun:test";
import { PNG } from "pngjs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  planImage,
  imageDimensions,
  imageLayout,
  type ImagePlacement,
} from "../packages/raster/src/image-plan";
import { importImage } from "../packages/raster/src/image-import";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { Preparations } from "../apps/server/preparations";
import { pluginFixture } from "./helpers/plugin-fixture";
import { limitedBody } from "../apps/server/request-body";
const placement: ImagePlacement = {
  name: "Survey overlay",
  bounds: [-180, 0, 0, 85.0511287798066],
  attribution: "Atlas test",
  license: "Test fixture",
};
function fixture(size = 512) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 4,
        right = x >= size / 2,
        bottom = y >= size / 2;
      png.data[k] = !right && !bottom ? 255 : 0;
      png.data[k + 1] = right && !bottom ? 255 : 0;
      png.data[k + 2] = bottom && !right ? 255 : 0;
      png.data[k + 3] = right && bottom ? 0 : 255;
    }
  return PNG.sync.write(png);
}
test("image placement validates size and bounds and derives zooms from resolution", async () => {
  const bytes = fixture(),
    p = await planImage(bytes, placement);
  expect(p.width).toBe(512);
  expect(p.layer.source.url).toBe(`urn:sha256:${p.sha256}`);
  expect(p.layer.registration?.method).toBe("north-up-mercator-bounds");
  expect(p.layer.maxZoom).toBe(2);
  expect(() => imageLayout(512, 512, [0, 0, 0, 1])).toThrow();
  expect(() => imageLayout(512, 512, [0, -90, 2, 90])).toThrow();
  expect(() => imageDimensions(new Uint8Array(50))).toThrow();
  const huge = Buffer.from(bytes);
  huge.writeUInt32BE(100000, 16);
  expect(() => imageDimensions(huge)).toThrow("32 megapixels");
  await expect(
    planImage(bytes, { ...placement, license: "" }),
  ).rejects.toThrow();
});
test("tile pyramid preserves geography, transparent pixels and offline standalone reads", async () => {
  const dir = await mkdtemp("/tmp/atlas-image-");
  let reader: AtlasReader | undefined;
  try {
    const bytes = fixture(),
      plan = await planImage(bytes, placement),
      phases: string[] = [];
    await Bun.write(dir + "/work/input.png", bytes);
    await importImage(
      plan,
      dir + "/work",
      dir + "/image.atlas",
      new AbortController().signal,
      (p) => phases.push(p.phase),
    );
    reader = await new AtlasReader(
      new FileSource(Bun.file(dir + "/image.atlas")),
    ).open();
    expect(reader.index.manifest.capabilities).toEqual(["raster-rendering"]);
    expect(reader.index.manifest.rasters![0]!.registration?.sha256).toBe(
      plan.sha256,
    );
    const encoded = await reader.block("raster/image/1/0/0");
    const decoded = PNG.sync.read(Buffer.from(encoded!));
    const pixel = (x: number, y: number) => [
      ...decoded.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4),
    ];
    expect(pixel(64, 64)).toEqual([255, 0, 0, 255]);
    expect(pixel(192, 64)).toEqual([0, 255, 0, 255]);
    expect(pixel(64, 192)).toEqual([0, 0, 255, 255]);
    expect(pixel(192, 192)[3]).toBe(0);
    reader.offline = true;
    expect(await reader.block("raster/image/1/0/0")).toEqual(encoded);
    expect(phases).toContain("compiling");
    expect(phases).toContain("packing");
  } finally {
    reader?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("cancelled imports reuse finished tiles, reject changed input and never overwrite a published file", async () => {
  const dir = await mkdtemp("/tmp/atlas-image-resume-");
  try {
    const bytes = fixture(),
      plan = await planImage(bytes, placement),
      cancel = new AbortController();
    await Bun.write(dir + "/work/input.png", bytes);
    await expect(
      importImage(
        plan,
        dir + "/work",
        dir + "/map.atlas",
        cancel.signal,
        (p) => {
          if (p.completed === 1) cancel.abort();
        },
      ),
    ).rejects.toThrow();
    expect(await Bun.file(dir + "/map.atlas").exists()).toBe(false);
    const before = (await stat(dir + "/work/tiles/0/0/0.png")).mtimeMs;
    const messages: string[] = [];
    await importImage(
      plan,
      dir + "/work",
      dir + "/map.atlas",
      new AbortController().signal,
      (p) => messages.push(p.message),
    );
    expect((await stat(dir + "/work/tiles/0/0/0.png")).mtimeMs).toBe(before);
    expect(messages.some((m) => m.includes("reused"))).toBe(true);
    await expect(
      importImage(
        plan,
        dir + "/work",
        dir + "/map.atlas",
        new AbortController().signal,
      ),
    ).rejects.toThrow("exists");
    await Bun.write(dir + "/work/input.png", fixture(256));
    await expect(
      importImage(
        plan,
        dir + "/work",
        dir + "/other.atlas",
        new AbortController().signal,
      ),
    ).rejects.toThrow("changed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("host uploads enforce origin, persist in the shared queue, serve after restart and delete cleanly", async () => {
  const dir = await mkdtemp("/tmp/atlas-upload-"),
    f = await pluginFixture();
  await Bun.write(dir + "/source.atlas", f.bytes);
  let manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  try {
    const request = (origin: string) => {
      const form = new FormData();
      form.append("placement", JSON.stringify(placement));
      form.append(
        "image",
        new File([new Uint8Array(fixture(256))], "../../escape.png", { type: "image/png" }),
      );
      return new Request("http://localhost/admin/preparations/image", {
        method: "POST",
        headers: { Origin: origin },
        body: form,
      });
    };
    expect(
      (await manager.handle(request("http://evil.test"), "127.0.0.1")).status,
    ).toBe(403);
    const response = await manager.handle(
      request("http://localhost"),
      "127.0.0.1",
    );
    expect(response.status).toBe(202);
    const queued = await response.json(),
      job = manager.jobs.get(queued.id)!;
    await until(() => ["ready", "failed"].includes(job.state));
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("ready");
    expect(job.manifest?.rasters).toHaveLength(1);
    await manager.close();
    manager = await Preparations.open(
      dir + "/hosted",
      dir + "/source.atlas",
      f.reader.index.manifest,
    );
    expect(manager.catalog().map((j) => j.id)).toContain(job.id);
    await manager.delete(job.id);
    expect(await Bun.file(manager.path(job.id)).exists()).toBe(false);
    expect(await Bun.file(dir + "/source.atlas").exists()).toBe(true);
  } finally {
    await manager.close();
    f.engine.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
test("request size limits also apply to streams without Content-Length", async () => {
  const request = () =>
    new Request("http://localhost", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(5));
          c.enqueue(new Uint8Array(5));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
  expect((await limitedBody(request(), 10)).length).toBe(10);
  await expect(limitedBody(request(), 9)).rejects.toThrow("too large");
});
async function until(check: () => boolean) {
  const end = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > end)
      throw new Error("Timed out waiting for image build");
    await Bun.sleep(10);
  }
}
