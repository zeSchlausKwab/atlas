import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  inspectMbtiles,
  importMbtiles,
  type RasterImportProgress,
} from "../packages/raster/src/mbtiles";
import {
  rasterDimensions,
  rasterTile,
  validateRasters,
} from "../packages/format/src/raster";
import { AtlasReader, FileSource } from "../packages/format/src/reader";
import { packRaster } from "../packages/raster/src/pack";
import { amendRasters } from "../packages/provisioning/src/raster-amend";
const jpeg = new Uint8Array(
  await Bun.file(
    new URL("fixtures/raster/white-256.jpg", import.meta.url),
  ).arrayBuffer(),
);
function fixture(
  path: string,
  normalized = true,
  png = false,
  scheme?: string,
) {
  const db = new Database(path);
  db.run("CREATE TABLE metadata(name TEXT,value TEXT)");
  for (const [k, v] of Object.entries({
    name: "Fixture imagery",
    format: png ? "png" : "jpg",
    bounds: "-90,-80,0,0",
    attribution: "<b>Atlas</b> &copy; test",
    license: "CC0 fixture",
    ...(scheme ? { scheme } : {}),
  }))
    db.query("INSERT INTO metadata VALUES (?,?)").run(k, v);
  if (normalized)
    db.run(`CREATE TABLE images(tile_id TEXT, tile_data BLOB); CREATE TABLE map(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_id TEXT);
    CREATE VIEW tiles AS SELECT zoom_level,tile_column,tile_row,tile_data FROM map JOIN images USING(tile_id);`);
  else
    db.run(
      "CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB)",
    );
  const bytes = png
    ? PNG.sync.write(new PNG({ width: 256, height: 256 }))
    : jpeg;
  if (normalized) {
    db.query("INSERT INTO images VALUES (?,?)").run("a", bytes);
    db.run("INSERT INTO map VALUES (2,1,0,'a'), (2,1,1,'a')");
  } else db.query("INSERT INTO tiles VALUES (2,1,0,?)").run(bytes);
  db.close();
  return bytes;
}
async function openAtlas(path: string) {
  return new AtlasReader(new FileSource(Bun.file(path))).open();
}
test("normalized JPEG MBTiles preserves bytes, flips TMS, fingerprints source and remains standalone", async () => {
  const dir = await mkdtemp("/tmp/atlas-mbtiles-");
  try {
    const input = dir + "/input.mbtiles",
      output = dir + "/one.atlas";
    fixture(input);
    const original = new Uint8Array(await Bun.file(input).arrayBuffer());
    const progress: RasterImportProgress[] = [];
    const info = await inspectMbtiles(input, { id: "satellite" });
    expect(info.tiles).toBe(2);
    expect(info.tileBytes).toBe(jpeg.length * 2);
    expect(info.layer.encoding).toBe("jpeg");
    expect(info.layer.source.attribution).toBe("Atlas © test");
    expect(await readdir(dir)).toEqual(["input.mbtiles"]);
    const result = await importMbtiles(
      input,
      output,
      { id: "satellite" },
      1024 ** 2,
      undefined,
      (p) => progress.push(p),
    );
    expect(result.layer.source.sha256).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    expect(new Uint8Array(await Bun.file(input).arrayBuffer())).toEqual(
      original,
    );
    expect(progress.at(-1)?.completed).toBe(progress.at(-1)?.total);
    expect(progress.some((p) => p.phase === "tiles" && p.completed === 2)).toBe(
      true,
    );
    await expect(importMbtiles(input, output)).rejects.toThrow(
      "already exists",
    );
    await rm(input);
    const r = await openAtlas(output);
    try {
      expect(r.index.manifest.rasters?.[0]?.mbtiles?.scheme).toBe("tms");
      expect(r.index.pages[0]!.prefix).toBe("raster/satellite");
      expect(await r.block("raster/satellite/2/1/3")).toEqual(jpeg);
      expect(await r.block("raster/satellite/2/1/2")).toEqual(jpeg);
      expect(await r.spatial("raster/satellite", 2, 1, 1, 0, 0)).toEqual([]);
      const read = r.bytesRead;
      r.offline = true;
      expect(await r.block("raster/satellite/2/1/3")).toEqual(jpeg);
      expect(r.bytesRead).toBe(read);
    } finally {
      r.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("flat PNG MBTiles honours explicit XYZ rows and supports source metadata overrides", async () => {
  const dir = await mkdtemp("/tmp/atlas-mbtiles-");
  try {
    const input = dir + "/input.mbtiles";
    const bytes = fixture(input, false, true, "xyz");
    const result = await importMbtiles(input, dir + "/one.atlas", {
      name: "Local overlay",
      attribution: "Test credit",
      license: "Local test",
    });
    expect(result.layer.name).toBe("Local overlay");
    expect(result.warnings).toHaveLength(1);
    const r = await openAtlas(dir + "/one.atlas");
    try {
      expect(await r.block("raster/imagery/2/1/0")).toEqual(
        new Uint8Array(bytes),
      );
    } finally {
      r.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("JPEG dimensions, frame and scan headers are checked before decoding", () => {
  expect(rasterDimensions(jpeg, "jpeg")).toEqual([256, 256]);
  expect(() => rasterTile(jpeg, { encoding: "jpeg", tileSize: 512 })).toThrow(
    "dimensions",
  );
  expect(() => rasterDimensions(jpeg.slice(0, -5), "jpeg")).toThrow();
  expect(() =>
    rasterDimensions(
      new Uint8Array([255, 216, 255, 192, 255, 255, 255, 217]),
      "jpeg",
    ),
  ).toThrow();
  expect(() => rasterDimensions(jpeg, "png")).toThrow();
});
test("MBTiles rejects vector formats, duplicates, non-Mercator and invalid addresses", async () => {
  const dir = await mkdtemp("/tmp/atlas-mbtiles-");
  try {
    for (const [i, sql, error] of [
      [0, "UPDATE metadata SET value='pbf' WHERE name='format'", "Unsupported"],
      [1, "INSERT INTO tiles SELECT * FROM tiles", "Duplicate"],
      [2, "UPDATE tiles SET tile_row=4", "Invalid MBTiles coordinate"],
      [3, "INSERT INTO metadata VALUES('profile','geodetic')", "Mercator"],
      [4, "DELETE FROM metadata WHERE name='bounds'", "bounds"],
    ] as const) {
      const input = `${dir}/${i}.mbtiles`;
      fixture(input, false);
      const db = new Database(input);
      db.run(sql);
      db.close();
      await expect(inspectMbtiles(input)).rejects.toThrow(error);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("bad later tile, budget, cancellation and source mutation publish nothing and preserve input", async () => {
  const dir = await mkdtemp("/tmp/atlas-mbtiles-");
  try {
    const input = dir + "/input.mbtiles",
      output = dir + "/one.atlas";
    fixture(input);
    await expect(importMbtiles(input, output, {}, 1)).rejects.toThrow("budget");
    const abort = new AbortController();
    await expect(
      importMbtiles(input, output, {}, 1024 ** 2, abort.signal, (p) => {
        if (p.phase === "tiles" && p.completed === 1) abort.abort();
      }),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["input.mbtiles"]);
    let changed = false;
    await expect(
      importMbtiles(input, output, {}, 1024 ** 2, undefined, (p) => {
        if (!changed && p.phase === "tiles" && p.completed === 1) {
          changed = true;
          // A source edited during the pass must not publish a stale fingerprint.
          utimesSync(input, new Date("2020-01-01"), new Date("2020-01-01"));
        }
      }),
    ).rejects.toThrow("source changed");
    expect(await readdir(dir)).toEqual(["input.mbtiles"]);
    const db = new Database(input);
    db.query("INSERT INTO images VALUES('bad',?)").run(
      new Uint8Array([255, 216, 255, 217]),
    );
    db.run("INSERT INTO map VALUES(2,2,1,'bad')");
    db.close();
    await expect(importMbtiles(input, output)).rejects.toThrow(
      "Invalid tile 2/2/1",
    );
    expect(await readdir(dir)).toEqual(["input.mbtiles"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JPEG imagery can be embedded in an immutable revision without its MBTiles donor", async () => {
  const dir = await mkdtemp("/tmp/atlas-mbtiles-");
  let target: AtlasReader | undefined, donor: AtlasReader | undefined;
  try {
    fixture(dir + "/png.mbtiles", false, true);
    fixture(dir + "/jpeg.mbtiles");
    await importMbtiles(dir + "/png.mbtiles", dir + "/base.atlas", {
      id: "original",
    });
    await importMbtiles(dir + "/jpeg.mbtiles", dir + "/donor.atlas", {
      id: "satellite",
    });
    target = await openAtlas(dir + "/base.atlas");
    donor = await openAtlas(dir + "/donor.atlas");
    await amendRasters(
      target,
      new Map([["donor", donor]]),
      {
        targetId: "base",
        targetSnapshot: target.index.manifest.snapshot,
        name: "Combined imagery",
        maxBytes: 1024 ** 2,
        layers: [
          { id: "original", name: "Original" },
          {
            id: "satellite",
            name: "Satellite",
            sourceId: "donor",
            sourceLayer: "satellite",
            sourceSnapshot: donor.index.manifest.snapshot,
          },
        ],
      },
      dir + "/amended.atlas",
      new AbortController().signal,
    );
    const expected = await target.block("raster/original/2/1/3");
    target.dispose();
    donor.dispose();
    for (const f of [
      "png.mbtiles",
      "jpeg.mbtiles",
      "base.atlas",
      "donor.atlas",
    ])
      await rm(dir + "/" + f);
    const amended = await openAtlas(dir + "/amended.atlas");
    try {
      expect(await amended.block("raster/satellite/2/1/3")).toEqual(jpeg);
      expect(await amended.block("raster/original/2/1/3")).toEqual(expected);
      expect(amended.index.manifest.rasters?.map((r) => r.encoding)).toEqual([
        "png",
        "jpeg",
      ]);
      expect(amended.index.manifest.rasters?.[1]?.source.sha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(
        amended.index.manifest.families?.find(
          (f) => f.id === "raster:satellite",
        )?.provenance?.fingerprint,
      ).toBe(amended.index.manifest.rasters?.[1]?.source.sha256);
    } finally {
      amended.dispose();
    }
  } finally {
    target?.dispose();
    donor?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("XYZ JPEG directory imports use the descriptor encoding", async () => {
  const dir = await mkdtemp("/tmp/atlas-mbtiles-");
  try {
    fixture(dir + "/input.mbtiles");
    const { layer } = await inspectMbtiles(dir + "/input.mbtiles");
    await Bun.write(dir + "/xyz/2/1/3.jpg", jpeg);
    const result = await packRaster(dir + "/xyz", layer, dir + "/xyz.atlas");
    expect(result.tiles).toBe(1);
    const r = await openAtlas(dir + "/xyz.atlas");
    try {
      expect(await r.block("raster/imagery/2/1/3")).toEqual(jpeg);
    } finally {
      r.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
