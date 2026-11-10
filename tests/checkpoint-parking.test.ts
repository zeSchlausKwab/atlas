import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import {
  parkCheckpoints,
  restoreCheckpoints,
  readParking,
  assertCheckpointsLocal,
} from "../packages/provisioning/src/checkpoint-parking";
import { Preparations } from "../apps/server/preparations";
import { pluginFixture } from "./helpers/plugin-fixture";
test("parking verifies retained bytes, blocks server resume/delete, and restores exact data", async () => {
  const dir = await mkdtemp("/tmp/atlas-parking-"),
    work = dir + "/hosted/" + crypto.randomUUID() + ".work",
    archive = dir + "/archive";
  const id = work.split("/").at(-1)!.replace(".work", "");
  await mkdir(work + "/compiler", { recursive: true });
  const f = await pluginFixture();
  const bytes = crypto.getRandomValues(new Uint8Array(32000));
  await Bun.write(work + "/compiler/source.sqlite", bytes);
  await Bun.write(
    dir + "/hosted/" + id + ".json",
    JSON.stringify({
      id,
      name: "Parked",
      state: "cancelled",
      createdAt: new Date().toISOString(),
      selection: {},
      progress: {},
    }),
  );
  const manager = await Preparations.open(
    dir + "/hosted",
    dir + "/source.atlas",
    f.reader.index.manifest,
  );
  try {
    let probes = 0;
    await parkCheckpoints({
      work,
      archive,
      files: ["compiler/source.sqlite"],
      checkIdle: async () => {
        probes++;
      },
    });
    expect(probes).toBeGreaterThan(1);
    expect(await Bun.file(work + "/compiler/source.sqlite").exists()).toBe(
      false,
    );
    expect(
      new Uint8Array(
        await Bun.file(archive + "/compiler/source.sqlite").arrayBuffer(),
      ),
    ).toEqual(bytes);
    expect((await readParking(work))?.phase).toBe("parked");
    await expect(manager.resume(id)).rejects.toThrow("parked");
    await expect(manager.delete(id)).rejects.toThrow("parked");
    // Resuming the same transfer checks the saved archive rather than discarding the guard.
    await parkCheckpoints({
      work,
      archive,
      files: ["compiler/source.sqlite"],
      checkIdle: async () => {},
    });
    // Simulate interruption after unlink but before recording removed=true.
    const interrupted = (await readParking(work))!;
    interrupted.files[0]!.removed = false;
    await Bun.write(
      work + "/checkpoint-parked.json",
      JSON.stringify(interrupted),
    );
    await restoreCheckpoints(work, async () => {}, 0);
    await expect(assertCheckpointsLocal(work)).resolves.toBeUndefined();
    expect(
      new Uint8Array(
        await Bun.file(work + "/compiler/source.sqlite").arrayBuffer(),
      ),
    ).toEqual(bytes);
  } finally {
    await manager.close();
    f.reader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("a live job cannot be parked and a corrupt archive cannot be restored", async () => {
  const dir = await mkdtemp("/tmp/atlas-parking-failure-"),
    work = dir + "/work",
    archive = dir + "/archive";
  await mkdir(work);
  await Bun.write(work + "/file", "original checkpoint");
  try {
    await expect(
      parkCheckpoints({
        work,
        archive,
        files: ["file"],
        checkIdle: async () => {
          throw Error("running");
        },
      }),
    ).rejects.toThrow("running");
    expect(await Bun.file(work + "/file").text()).toBe("original checkpoint");
    await parkCheckpoints({
      work,
      archive,
      files: ["file"],
      checkIdle: async () => {},
    });
    await Bun.write(archive + "/file", "damaged");
    await expect(restoreCheckpoints(work, async () => {}, 0)).rejects.toThrow(
      "checksum",
    );
    expect(await readParking(work)).toBeDefined();
    expect(await Bun.file(work + "/file").exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
