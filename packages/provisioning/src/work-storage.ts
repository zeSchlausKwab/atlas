/** Build placement is pinned to each job. Network storage holds files, never writable SQLite. */
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BUILD_DISK_FLOOR, checkStorageEstimate } from "./capacity";
export type WorkPolicy = "map-disk" | "when-needed" | "always";
export interface WorkLocation {
  root: string;
  label: string;
  kind: "local" | "network";
  volumeId: string;
}
export interface WorkSettings {
  version: 1;
  policy: WorkPolicy;
  location?: WorkLocation;
}
export interface BuildWorkspace {
  version: 1;
  jobId: string;
  location: WorkLocation;
  work: string;
  artifacts: string;
  reason: "low-space" | "preferred";
  mode: "local" | "nas-assisted";
}
const marker = ".atlas-work-volume.json";
const gib = 1024 ** 3;
const decode = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
export function mountType(path: string, mountinfo: string) {
  return (
    mountinfo
      .split("\n")
      .map((line) => {
        const [left, right] = line.split(" - ");
        return {
          path: decode(left?.split(" ")[4] ?? ""),
          type: right?.split(" ")[0] ?? "",
        };
      })
      .filter(
        (m) =>
          m.path &&
          (path === m.path || path.startsWith(m.path.replace(/\/$/, "") + "/")),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]?.type ?? ""
  );
}
export async function locationKind(path: string): Promise<"local" | "network"> {
  const info = await Bun.file("/proc/self/mountinfo")
    .text()
    .catch(() => "");
  const type = mountType(path, info);
  // Unknown/FUSE filesystems use the conservative split layout too.
  if (type)
    return /^(ext[234]|xfs|btrfs|zfs|f2fs|tmpfs)$/.test(type)
      ? "local"
      : "network";
  const fs = await statfs(path);
  // APFS/HFS on macOS; Linux EXT/XFS/BTRFS for platforms without mountinfo.
  return [0x1a, 0x11, 0xef53, 0x58465342, 0x9123683e].includes(Number(fs.type))
    ? "local"
    : "network";
}
export async function workspaceSpace(path: string) {
  const disk = await statfs(path);
  return {
    availableBytes: disk.bavail * disk.bsize,
    totalBytes: disk.blocks * disk.bsize,
  };
}
async function validateLocation(location: WorkLocation) {
  if ((await realpath(location.root)) !== location.root)
    throw Error("Working folder changed. Reconnect its original disk.");
  const saved = await Bun.file(join(location.root, marker)).json();
  if (saved.id !== location.volumeId)
    throw Error(
      "Working disk is missing or was replaced. Reconnect the original disk before resuming.",
    );
  if ((await locationKind(location.root)) !== location.kind)
    throw Error("Working filesystem changed. Test the folder again.");
}
function paths(w: BuildWorkspace) {
  if (!/^[a-f0-9-]{36}$/.test(w.jobId)) throw Error("Invalid workspace job");
  const external = join(w.location.root, `${w.jobId}.work`);
  if (
    w.mode === "local"
      ? w.work !== external || w.artifacts !== external
      : w.artifacts !== external || w.work === external
  )
    throw Error("Invalid workspace placement");
  return external;
}
export async function checkWorkspace(
  w: BuildWorkspace,
  floor = BUILD_DISK_FLOOR,
) {
  paths(w);
  await validateLocation(w.location);
  const external = await workspaceSpace(w.location.root);
  if (external.availableBytes < floor)
    throw Error(
      `Working disk has less than ${floor / gib} GiB free. Checkpoints are retained; reconnect or free space before resuming.`,
    );
}
export async function initializeWorkspace(w: BuildWorkspace) {
  await checkWorkspace(w);
  await mkdir(w.work, { recursive: true });
  await mkdir(w.artifacts, { recursive: true });
}
export async function removeWorkspace(w: BuildWorkspace) {
  const external = paths(w);
  await validateLocation(w.location);
  await rm(external, { recursive: true, force: true });
}
export function workspaceAdmission(
  needed: number,
  mode: BuildWorkspace["mode"],
) {
  return {
    external: needed,
    local:
      mode === "nas-assisted"
        ? Math.min(needed, BUILD_DISK_FLOOR + 64 * gib)
        : BUILD_DISK_FLOOR,
  };
}
export class WorkStorage {
  private file: string;
  constructor(readonly maps: string) {
    this.file = join(maps, "work-storage.json");
  }
  async settings(): Promise<WorkSettings> {
    return (await Bun.file(this.file).exists())
      ? await Bun.file(this.file).json()
      : { version: 1, policy: "map-disk" };
  }
  async test(
    path: unknown,
    label?: unknown,
  ): Promise<
    WorkLocation & {
      availableBytes: number;
      totalBytes: number;
      sameDisk: boolean;
    }
  > {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
      throw Error(
        "Choose an absolute folder path on this server. Mount SMB shares before selecting them.",
      );
    const parent = await realpath(path); // Never recreate a missing mount point on the system disk.
    const root = parent.endsWith("/atlas-workspaces")
      ? parent
      : join(parent, "atlas-workspaces");
    await mkdir(root, { recursive: true });
    const probe = await mkdtemp(join(root, ".probe-"));
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(4096));
      const fd = await open(join(probe, "write"), "wx");
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(join(probe, "write"), join(probe, "read"));
      const read = new Uint8Array(
        await Bun.file(join(probe, "read")).arrayBuffer(),
      );
      if (read.length !== bytes.length || read.some((b, i) => b !== bytes[i]))
        throw Error("Working folder read/write test failed");
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
    const mark = join(root, marker);
    if (!(await Bun.file(mark).exists())) {
      try {
        const fd = await open(mark, "wx");
        try {
          await fd.writeFile(JSON.stringify({ id: crypto.randomUUID() }));
          await fd.sync();
        } finally {
          await fd.close();
        }
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const volumeId = (await Bun.file(mark).json()).id;
    if (typeof volumeId !== "string")
      throw Error("Invalid working-folder marker");
    const canonical = await realpath(root),
      kind = await locationKind(canonical);
    return {
      root: canonical,
      kind,
      volumeId,
      label:
        typeof label === "string" && label.trim()
          ? label.trim().slice(0, 80)
          : kind === "network"
            ? "NAS workspace"
            : "Extra disk",
      ...(await workspaceSpace(root)),
      sameDisk: (await stat(root)).dev === (await stat(this.maps)).dev,
    };
  }
  async save(value: { policy?: unknown; path?: unknown; label?: unknown }) {
    if (!["map-disk", "when-needed", "always"].includes(value.policy as string))
      throw Error("Choose a build storage policy");
    const old = await this.settings();
    const location = value.path
      ? await this.test(value.path, value.label)
      : old.location;
    if (value.policy !== "map-disk" && !location)
      throw Error("Test and select a working folder first");
    if (location && value.policy !== "map-disk")
      await validateLocation(location);
    const settings: WorkSettings = {
      version: 1,
      policy: value.policy as WorkPolicy,
      location: location && {
        root: location.root,
        kind: location.kind,
        volumeId: location.volumeId,
        label: location.label,
      },
    };
    await Bun.write(this.file + ".tmp", JSON.stringify(settings, null, 2));
    await rename(this.file + ".tmp", this.file);
    return settings;
  }
  async choose(
    id: string,
    needed: number,
    primaryFree: number,
  ): Promise<BuildWorkspace | undefined> {
    const settings = await this.settings();
    if (
      settings.policy === "map-disk" ||
      (settings.policy === "when-needed" && primaryFree >= needed)
    )
      return;
    const location = settings.location;
    if (!location) throw Error("No extra working disk configured");
    await validateLocation(location);
    const external = join(location.root, `${id}.work`);
    return {
      version: 1,
      jobId: id,
      location,
      mode: location.kind === "network" ? "nas-assisted" : "local",
      work:
        location.kind === "network"
          ? resolve(this.maps, `${id}.work`)
          : external,
      artifacts: external,
      reason: settings.policy === "always" ? "preferred" : "low-space",
    };
  }
  async admit(
    w: BuildWorkspace,
    needed: number,
    primaryFree: number,
    override: boolean,
  ) {
    await checkWorkspace(w);
    const estimate = workspaceAdmission(needed, w.mode);
    checkStorageEstimate(estimate.local, primaryFree, override);
    checkStorageEstimate(
      estimate.external,
      (await workspaceSpace(w.location.root)).availableBytes,
      override,
    );
  }
  async status() {
    const settings = await this.settings();
    let location: any;
    if (settings.location) {
      try {
        await validateLocation(settings.location);
        location = {
          ...settings.location,
          ...(await workspaceSpace(settings.location.root)),
          online: true,
          sameDisk:
            (await stat(settings.location.root)).dev ===
            (await stat(this.maps)).dev,
        };
      } catch (e) {
        location = { ...settings.location, online: false, error: String(e) };
      }
    }
    const candidates: Array<{
      path: string;
      label: string;
      kind: string;
      availableBytes: number;
      totalBytes: number;
    }> = [];
    const add = async (path: string, label: string) => {
      try {
        if (!candidates.some((c) => c.path === path))
          candidates.push({
            path,
            label,
            kind: await locationKind(path),
            ...(await workspaceSpace(path)),
          });
      } catch {}
    };
    const gvfs = `/run/user/${process.getuid?.() ?? 1000}/gvfs`;
    for (const name of await readdir(gvfs).catch(() => []))
      if (name.startsWith("smb-share:")) {
        const share = join(gvfs, name),
          atlas = join(share, "atlas");
        await add(
          await realpath(atlas).catch(() => share),
          name.replace("smb-share:", "").replace(/,/g, " · "),
        );
      }
    for (const base of [
      "/Volumes",
      "/media",
      "/mnt",
      `/run/media/${process.env.USER ?? ""}`,
    ])
      for (const name of await readdir(base).catch(() => []))
        await add(join(base, name), name);
    return {
      settings,
      primary: { path: this.maps, ...(await workspaceSpace(this.maps)) },
      location,
      candidates,
    };
  }
}
