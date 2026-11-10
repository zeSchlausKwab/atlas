import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkStorage,
  mountType,
  initializeWorkspace,
  checkWorkspace,
  removeWorkspace,
  workspaceAdmission,
} from "../packages/provisioning/src/work-storage";
import { BUILD_DISK_FLOOR } from "../packages/provisioning/src/capacity";
import { publishPrepared } from "../packages/provisioning/src/publish-prepared";

test("mount selection recognizes nested GVFS/SMB and escaped paths", () => {
  const mounts =
    "1 0 0:1 / / rw - ext4 /dev/a rw\n2 1 0:2 / /run/user/1000/gvfs rw - fuse.gvfsd-fuse gvfs rw\n3 1 0:3 / /media/Extra\\040Disk rw - xfs /dev/b rw";
  expect(
    mountType(
      "/run/user/1000/gvfs/smb-share:server=nas,share=public/atlas",
      mounts,
    ),
  ).toBe("fuse.gvfsd-fuse");
  expect(mountType("/media/Extra Disk/atlas", mounts)).toBe("xfs");
  expect(mountType("/media/Extra Diskette", mounts)).toBe("ext4");
});

test("storage policy persists, automatic placement only overflows, and old jobs keep their pinned disk", async () => {
  const dir = await realpath(await mkdtemp("/tmp/atlas-work-storage-"));
  const maps = join(dir, "maps"),
    extra = join(dir, "extra"),
    other = join(dir, "other");
  await Promise.all([maps, extra, other].map((p) => mkdir(p)));
  const store = new WorkStorage(maps),
    id = crypto.randomUUID();
  try {
    expect(await store.choose(id, 100, 10)).toBeUndefined();
    const tested = await store.test(extra);
    expect(tested.sameDisk).toBe(true);
    await store.save({ policy: "when-needed", path: extra });
    expect(await store.choose(id, 100, 100)).toBeUndefined();
    const job = (await store.choose(id, 100, 99))!;
    expect(job.reason).toBe("low-space");
    await initializeWorkspace(job);
    await Bun.write(join(job.artifacts, "retained"), "checkpoint");
    await store.save({ policy: "always", path: other });
    expect(
      (await new WorkStorage(maps).choose(crypto.randomUUID(), 1, 1e20))!
        .location.root,
    ).not.toBe(job.location.root);
    await checkWorkspace(job, 0);
    expect(await Bun.file(join(job.artifacts, "retained")).text()).toBe(
      "checkpoint",
    );
    await removeWorkspace(job);
    expect(await Bun.file(join(job.artifacts, "retained")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(tested.root, ".atlas-work-volume.json")).exists(),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unmounted/replaced working disk fails closed; switching to map disk still works", async () => {
  const dir = await realpath(await mkdtemp("/tmp/atlas-work-missing-"));
  await mkdir(join(dir, "maps"));
  await mkdir(join(dir, "mounted"));
  const store = new WorkStorage(join(dir, "maps"));
  try {
    await store.save({ policy: "always", path: join(dir, "mounted") });
    const job = (await store.choose(crypto.randomUUID(), 1, 1e20))!;
    await initializeWorkspace(job);
    await rename(join(dir, "mounted"), join(dir, "unmounted"));
    await expect(initializeWorkspace(job)).rejects.toThrow();
    await expect(store.choose(crypto.randomUUID(), 1, 1e20)).rejects.toThrow();
    expect((await store.status()).location.online).toBe(false);
    await mkdir(join(dir, "mounted"));
    await mkdir(job.location.root);
    await expect(initializeWorkspace(job)).rejects.toThrow();
    expect(await Bun.file(join(job.artifacts, "test")).exists()).toBe(false);
    await store.save({ policy: "map-disk" });
    expect(await store.choose(crypto.randomUUID(), 1, 0)).toBeUndefined();
    await expect(store.test(join(dir, "does-not-exist"))).rejects.toThrow();
    await expect(store.test("smb://nas/public")).rejects.toThrow("absolute");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NAS assistance retains an SSD allowance for databases; publication handles cancellation", async () => {
  expect(workspaceAdmission(200 * 1024 ** 3, "nas-assisted").local).toBe(
    BUILD_DISK_FLOOR + 64 * 1024 ** 3,
  );
  expect(workspaceAdmission(200 * 1024 ** 3, "local").external).toBe(
    200 * 1024 ** 3,
  );
  const dir = await mkdtemp("/tmp/atlas-publish-");
  try {
    await Bun.write(join(dir, "source"), "verified map");
    await expect(
      publishPrepared(
        join(dir, "source"),
        join(dir, "final"),
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(await Bun.file(join(dir, "source")).text()).toBe("verified map");
    expect(await Bun.file(join(dir, "final")).exists()).toBe(false);
    await publishPrepared(
      join(dir, "source"),
      join(dir, "final"),
      new AbortController().signal,
    );
    expect(await Bun.file(join(dir, "final")).text()).toBe("verified map");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
